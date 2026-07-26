/**
 * useVListLabels.ts — Single source of truth for every localized string the
 * pretext vlist paints.
 *
 * The vlist render/measure/adapter layers must stay free of i18n imports
 * (CONTRACT.md §0 rule 1: no app coupling inside the pure path), so each
 * RenderXxx declares a `labels` prop with English fallbacks and the ADAPTER
 * reads chrome strings through `ctx.labels`. That leaves exactly one place that
 * is allowed to know about i18next — the integration shell — and this module is
 * it.
 *
 * Two products come out of the same translation pass:
 *
 *   adapterLabels  → forwarded into the layout pipeline (`ctx.labels`) for the
 *                    system cards + trace headers whose TEXT is composed during
 *                    adaptation (and therefore participates in measurement).
 *                    Interpolated entries keep a literal `{count}` placeholder
 *                    that the adapter substitutes with the live number.
 *   renderLabels   → per-kind `labels` objects handed to renderElement via the
 *                    render extra, for chrome the render layer draws directly
 *                    (buttons, badges, placeholders, section titles).
 *
 * Height note: every render-layer label sits in a fixed-height row (button bar,
 * badge, clamped single line, section title), so translating them cannot change
 * a measured height. Strings that DO drive height (card body text, trace row
 * titles) flow through the adapter instead, where they are measured.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

/**
 * Literal placeholder passed as i18next's `count` so plural selection resolves
 * at injection time while the number itself stays dynamic. The adapter / render
 * layer replaces `{count}` with the live value.
 */
const COUNT_PLACEHOLDER = "{count}" as unknown as number;

/**
 * The section-label ids a tool detail can carry. A local mirror of
 * `ToolSectionLabel` (measure-tool-call / tool-detail): declaring it here keeps
 * this module free of a measure-layer import while `Record<…, string>` still
 * forces the bundle below to cover EVERY id — a new label without a translation
 * is a compile error, not a silently English card.
 */
export type ToolSectionLabelId =
	| "input"
	| "output"
	| "command"
	| "message"
	| "delivery"
	| "reply"
	| "result"
	| "rule"
	| "captured"
	| "files"
	| "plan"
	| "error";

/** Per-kind render label bundles, keyed by the vlist element kind. */
export interface VListRenderLabels {
	reasoning: {
		reasoning: string;
		thinking: string;
		/** Builder: the step count is per element. */
		countLabel: (stepCount: number) => string;
		/** Builder: receives the already-locale-formatted char count. */
		charsLabel: (formatted: string) => string;
		translationLabel: string;
	};
	toolCall: {
		input: string;
		output: string;
		remote: string;
		/** `_planFile` provenance template carrying a literal `{file}` placeholder. */
		planSource: string;
		/**
		 * Localized text per section label id. The measure layer only carries the
		 * semantic id (`shared/` has no i18n); this is where the wording lands.
		 */
		sections: Record<ToolSectionLabelId, string>;
		/** Share-card action buttons. */
		download: string;
		copy: string;
		copied: string;
		/** Terminate a running bash / MCP tool. */
		terminate: string;
		permission: VListRenderLabels["permission"];
		/** Reflection-notice chrome (the takeover button only). */
		reflection: { takeOver: string };
	};
	toolCallGroup: { label: string; statusLabel: string };
	trace: { hideEarlier: string; showEarlier: (hiddenCount: number) => string };
	subagent: {
		recentCalls: string;
		openSession: string;
		prompt: string;
		pendingTitle: string;
		resolveOverride: string;
		waitingBadge: string;
		backgroundBadge: string;
	};
	permission: {
		executionTarget: string;
		executionTargetLocal: string;
		planEdited: string;
		feedbackPlaceholder: string;
		unavailable: string;
		allow: string;
		deny: string;
	};
	askUserQuestion: {
		submit: string;
		skip: string;
		answered: string;
		countdown: string;
		customPlaceholder: string;
	};
	askInPassing: {
		hint: string;
		placeholder: string;
		confirm: string;
		cancel: string;
		resolvedLabel: string;
	};
	planCard: string;
	pruneDivider: string;
}

export interface VListLabels {
	/** Chrome strings the pure adapter composes into measured card text. */
	adapterLabels: Record<string, string>;
	/** Per-kind label bundles for the render layer. */
	renderLabels: VListRenderLabels;
}

/** Reflection kinds, in the i18n key spelling the adapter builds. */
const REFLECTION_LABEL_KINDS = ["danger", "plan", "question", "task"] as const;
/** Reflection statuses, in the i18n key spelling the adapter builds. */
const REFLECTION_LABEL_STATES = [
	"Running",
	"AwaitingUser",
	"Confirmed",
	"Cancelled",
	"Aborted",
	"Resolved",
] as const;

/**
 * Build every `${kind}Reflection${State}` title the adapter can ask for.
 *
 * These are ADAPTER labels because the title is measured: it wraps on narrow
 * cards, so its wording changes the reflection notice's height. Enumerating the
 * full matrix here (24 entries) keeps the adapter free of i18n while guaranteeing
 * a title is never missing at layout time — a missing key would fall back to the
 * English default and silently measure a different string than it paints.
 */
export function reflectionTitleLabels(t: (key: string) => string): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const kind of REFLECTION_LABEL_KINDS) {
		for (const state of REFLECTION_LABEL_STATES) {
			const key = `${kind}Reflection${state}`;
			labels[key] = t(key);
		}
	}
	return labels;
}

/**
 * Resolve every vlist-facing string once per language change. Both products are
 * referentially stable across renders so the document layout memo and the
 * per-row `ExactRow` memo keep skipping unchanged work.
 */
export function useVListLabels(): VListLabels {
	const { t } = useTranslation("narrator");
	const { t: tCommon } = useTranslation("common");

	const adapterLabels = useMemo<Record<string, string>>(
		() => ({
			// ── compact / segment-compact indicator lines ───────────────────────────
			compacting: t("compacting"),
			compacted: t("compacted"),
			compactFailed: t("compactFailed"),
			compactOutputChars: t("compactOutputChars", { count: COUNT_PLACEHOLDER }),
			segmentCompacting: t("segmentCompacting"),
			segmentCompacted: t("segmentCompacted", { count: COUNT_PLACEHOLDER }),
			segmentCompactFailed: t("segmentCompactFailed"),
			segmentCompactFailedDesc: t("segmentCompactFailedDesc"),
			dismiss: t("dismiss"),
			unknownError: tCommon("unknownError"),
			// ── single-line system cards ────────────────────────────────────────────
			mergeSummaryLabel: t("mergeSummaryLabel"),
			reviewFeedbackLabel: t("reviewFeedbackLabel"),
			// ── read-only AskUserQuestion replay ────────────────────────────────────
			// These prefixes wrap together with the answer text, so they are MEASURED
			// (adapter labels) rather than substituted by the render layer.
			askAnswerPrefix: t("askAnswerPrefix"),
			askCustomAnswerPrefix: t("askCustomAnswerPrefix"),
			specProtectedBadge: t("specProtectedBadge"),
			specGoalAddedBadge: t("specGoalAddedBadge"),
			specGoalExistsBadge: t("specGoalExistsBadge"),
			specGoalViewTasks: t("specGoalViewTasks"),
			specContinuation: t("specContinuation"),
			specBlockedContinuation: t("specBlockedContinuation"),
			// ── spec fork-carryover / context-cleared card ──────────────────────────
			specForkCarryover: t("specForkCarryoverTitle"),
			specContextCleared: t("specClearedCarryoverTitle"),
			specViewTasks: t("specGoalViewTasks"),
			specClearTasks: t("specForkClearTasks"),
			specResetTasks: t("specForkResetSpec"),
			specForkCarryoverDesc: t("specForkCarryoverDesc", {
				count: COUNT_PLACEHOLDER,
				open: "{open}",
				protectedOpen: "{protectedOpen}",
			}),
			// ── trace headers + count lines (CollapsibleTrace parity) ───────────────
			reasoning: t("reasoning"),
			reasoningSteps: t("reasoningSteps", { count: COUNT_PLACEHOLDER }),
			reasoningCount: t("reasoningCount", { count: COUNT_PLACEHOLDER }),
			toolCalls: t("toolCalls"),
			toolCallsCount: t("toolCallsCount", { count: COUNT_PLACEHOLDER }),
			activityTraceLabel: t("activityTraceLabel"),
			activityTraceCount: t("activityTraceCount", {
				reasoning: "{reasoning}",
				tools: "{tools}",
			}),
			toolGeneric: t("toolGeneric"),
			// ── post-error subagent recovery card ───────────────────────────────────
			subagentRecoveryTitle: t("subagentRecoveryTitle"),
			subagentRecoveryDescription: t("subagentRecoveryDescription", {
				count: COUNT_PLACEHOLDER,
			}),
			subagentRecoveryToBackground: t("subagentRecoveryToBackground"),
			subagentRecoveryResumeAndNotify: t("subagentRecoveryResumeAndNotify"),
			subagentRecoveryResumeAndWait: t("subagentRecoveryResumeAndWait"),
			subagentRecoveryResolvedNotify: t("subagentRecoveryResolvedNotify", {
				count: COUNT_PLACEHOLDER,
			}),
			subagentRecoveryResolvedWait: t("subagentRecoveryResolvedWait", {
				count: COUNT_PLACEHOLDER,
			}),
			// ── reflection notice titles (MEASURED, so they belong here) ─────────────
			// Keys are `${kind}Reflection${Status}`, built by the adapter from
			// reflectionTitleKeyPrefix/Suffix. The title wraps at narrow widths and
			// therefore participates in the card's height, which is why it flows
			// through the adapter rather than the render layer.
			...reflectionTitleLabels(t),
			reflectionNextSteps: t("reflectionNextSteps", { nextSteps: "{nextSteps}" }),
		}),
		[t, tCommon],
	);

	const renderLabels = useMemo<VListRenderLabels>(() => {
		const permission = {
			executionTarget: t("executionTarget"),
			executionTargetLocal: t("executionTargetLocal"),
			planEdited: t("planEdited"),
			feedbackPlaceholder: t("feedbackPlaceholder"),
			unavailable: t("permissionActionsUnavailable"),
			allow: tCommon("allow"),
			deny: tCommon("deny"),
		};
		return {
			reasoning: {
				reasoning: t("reasoning"),
				thinking: t("thinking"),
				countLabel: (stepCount: number) => t("reasoningSteps", { count: stepCount }),
				charsLabel: (formatted: string) => t("reasoningChars", { formatted }),
				translationLabel: t("showOriginal"),
			},
			toolCall: {
				input: tCommon("input"),
				output: tCommon("output"),
				remote: t("toolCallRemoteBadge"),
				// The raw `_planFile` path lives in the measured detail (shared/ has no
				// i18n), so inject the template with a literal placeholder and let the
				// render layer substitute the path — same trick as COUNT_PLACEHOLDER.
				planSource: t("planSourceFile", { file: "{file}" }),
				// Multi-part details label each section by a semantic id; this is the
				// one place those ids become words.
				sections: {
					input: tCommon("input"),
					output: tCommon("output"),
					command: t("toolSectionCommand"),
					message: t("toolSectionMessage"),
					delivery: t("toolSectionDelivery"),
					reply: t("toolSectionReply"),
					result: t("toolSectionResult"),
					rule: t("pipelineRule"),
					captured: t("pipelineCapturedAliases"),
					files: t("toolSkillFiles"),
					plan: t("plan"),
					error: t("toolSectionError"),
				},
				download: tCommon("download"),
				copy: tCommon("copy"),
				copied: tCommon("copied"),
				terminate: t("terminateProcess"),
				permission,
				// Only the takeover BUTTON is render-side chrome; the notice's text rows
				// are measured and therefore come through adapterLabels.
				reflection: { takeOver: t("manualTakeoverReflection") },
			},
			toolCallGroup: {
				label: t("toolCalls"),
				statusLabel: t("toolCallGroupStatusPending"),
			},
			trace: {
				hideEarlier: t("reasoningHideEarlier"),
				showEarlier: (hiddenCount: number) => t("reasoningShowEarlier", { count: hiddenCount }),
			},
			subagent: {
				recentCalls: t("subagentRecentCalls"),
				openSession: t("openFullSubagentSession"),
				prompt: t("subagentPrompt"),
				pendingTitle: t("subagentWaitingPermissionTitle"),
				resolveOverride: t("resolveOverride"),
				// `waitingBadge` is declared by RenderSubagent but never painted; it is
				// filled from the same title so the bundle stays type-complete.
				waitingBadge: t("subagentWaitingPermissionTitle"),
				backgroundBadge: t("backgroundBadge"),
			},
			permission,
			askUserQuestion: {
				submit: t("submitAnswer"),
				skip: t("skipQuestion"),
				answered: t("answered"),
				countdown: t("questionAutoAnswerSoon"),
				customPlaceholder: t("typeCustomAnswer"),
			},
			askInPassing: {
				hint: t("askInPassing_hint"),
				placeholder: t("askInPassing_placeholder"),
				confirm: t("askInPassing_confirm"),
				cancel: t("askInPassing_cancel"),
				resolvedLabel: t("askInPassing_resolvedLabel"),
			},
			planCard: t("perm_plan"),
			pruneDivider: t("pruneBoundaryLabel"),
		};
	}, [t, tCommon]);

	return useMemo(() => ({ adapterLabels, renderLabels }), [adapterLabels, renderLabels]);
}

/**
 * Resolve the per-kind render `labels` value for an element kind, or undefined
 * when that kind draws no chrome of its own. Pure so the mapping stays testable
 * and the two call sites (stable rows + streaming tail) cannot drift.
 */
export function renderLabelsForKind(kind: string, labels: VListRenderLabels): unknown | undefined {
	switch (kind) {
		case "reasoning":
			return labels.reasoning;
		case "tool-call":
			return labels.toolCall;
		case "tool-run-summary":
		case "activity-trace":
		case "reasoning-steps":
			return labels.trace;
		case "subagent-card":
			return labels.subagent;
		case "inline-permission":
			return labels.permission;
		case "ask-user-question":
			return labels.askUserQuestion;
		case "ask-in-passing":
			return labels.askInPassing;
		default:
			return undefined;
	}
}
