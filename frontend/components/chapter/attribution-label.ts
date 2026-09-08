/** Display observations without turning historical participants into current diff owners. */
import type {
	AttributionActor,
	CurrentDiffTarget,
	FileModificationGroup,
} from "@frontend/hooks/useGit";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

export interface AttributionLabels {
	short: string;
	detail: string;
}

export type AttributionLabelKind = "narrator" | "human" | "external" | "deleted" | "unknown";

/** The latest event's own actor is authoritative. Group-wide flags cannot choose its label. */
export function attributionLabelKind(
	actor: AttributionActor | null | undefined,
): AttributionLabelKind {
	if (!actor) return "unknown";
	if (actor.kind === "external_unknown") return "external";
	if (actor.kind === "human") return "human";
	if (actor.deleted === true) return "deleted";
	return actor.exists && !!actor.narratorId ? "narrator" : "unknown";
}

export function buildAttributionLabels(
	actor: AttributionActor | null | undefined,
	t: Translate,
): AttributionLabels {
	const kind = attributionLabelKind(actor);
	const name = actor?.title?.trim() || null;
	if (kind === "human") {
		const label =
			actor?.exists && name
				? t("attributionHuman", { name })
				: t(actor?.deleted === true ? "attributionDeletedUser" : "attributionUnknownUser");
		return { short: label, detail: label };
	}
	if (kind !== "narrator") {
		const label = t(
			kind === "external"
				? "attributionExternal"
				: kind === "deleted"
					? "attributionDeletedSession"
					: actor && actor.kind !== "external_unknown"
						? "attributionUnknownSession"
						: "attributionUnknown",
		);
		// Retain a deleted/missing subagent's known subtype, but never its guessed name.
		const detail = actor?.subagentType
			? t("attributionSubagentDetail", { name: label, type: actor.subagentType })
			: label;
		return { short: label, detail };
	}
	if (!actor?.subagentType) {
		const label = name ?? t("attributionUnnamed");
		return { short: label, detail: label };
	}
	const type = actor.subagentType;
	const short = name ?? t("attributionSubagentUnnamed", { type });
	const detail = actor.parentTitle?.trim()
		? t("attributionSubagentDetailWithParent", {
				name: short,
				type,
				parent: actor.parentTitle.trim(),
			})
		: t("attributionSubagentDetail", { name: short, type });
	return { short, detail };
}

/** Anonymous buckets are labels, not proof that two observations share one real subject. */
function actorKey(actor: AttributionActor): string {
	if (actor.subjectKey) return actor.subjectKey;
	if (actor.userId) return `human:${actor.userId}`;
	if (actor.narratorId) return `narrator:${actor.narratorId}`;
	return `${actor.kind}:unknown:${actor.subagentType ?? ""}`;
}

export interface AttributionBadgeContent {
	label: string;
	/** Additional identified historical subjects only; anonymous buckets are not counted. */
	extraCount: number;
	extraCountIsLowerBound: boolean;
	incomplete: boolean;
	tooltipLines: string[];
	hasNarrator: boolean;
}

export function buildAttributionBadge(
	attribution: FileModificationGroup,
	t: Translate,
): AttributionBadgeContent {
	const lastActor = attribution.lastActor;
	const labels = buildAttributionLabels(lastActor, t);
	const others = [
		...new Map(attribution.actors.map((actor) => [actorKey(actor), actor])).values(),
	].filter((actor) => actorKey(actor) !== actorKey(lastActor));
	const coverage = attribution.completeness;
	// Missing metadata from an older server/cache is unknown, never implicitly complete.
	const truncated = !coverage?.fileHistoryComplete || coverage.contributorsTruncated;
	const countsLowerBound = truncated || coverage.countsLowerBound;
	const tooltipLines = [t("attributionLastModified", { name: labels.detail })];
	if (attribution.lastAction) {
		tooltipLines.push(
			t("attributionLastAction", {
				action: t(`attributionAction.${attribution.lastAction}`),
			}),
		);
	}
	for (const candidate of others) {
		tooltipLines.push(
			t("attributionAlsoModified", {
				name: buildAttributionLabels(candidate, t).detail,
			}),
		);
	}
	tooltipLines.push(t(truncated ? "attributionHistoryTruncated" : "attributionHistoryComplete"));
	if (countsLowerBound) tooltipLines.push(t("attributionCountsLowerBound"));
	if (
		!coverage?.warningScanComplete ||
		attribution.hasExternalChange === null ||
		attribution.hasDeletedActor === null
	) {
		tooltipLines.push(t("attributionFlagsUnknown"));
	}
	// No v1 action, including Write/Edit, establishes settled measured ownership.
	tooltipLines.push(
		t(attribution.evidence === "v2" ? "attributionRecordedEvidence" : "attributionLegacyObserved"),
	);
	tooltipLines.push(t("attributionNotCurrentOwnership"));
	if (attribution.hasImpreciseAttribution) tooltipLines.push(t("attributionImprecise"));
	return {
		label: labels.short,
		// If the newest subject is anonymous, it could be any earlier subject: do not
		// claim they are distinct people via a numeric '+N'. The tooltip still lists them.
		extraCount: lastActor.identityKnown ? others.filter((actor) => actor.identityKnown).length : 0,
		extraCountIsLowerBound: countsLowerBound,
		incomplete: truncated || countsLowerBound,
		tooltipLines,
		hasNarrator: attributionLabelKind(lastActor) === "narrator",
	};
}

/** Current target evidence is never synthesized from the historical group. */
export function buildCurrentAttributionBadge(
	current: CurrentDiffTarget | undefined,
	history: FileModificationGroup | undefined,
	t: Translate,
): AttributionBadgeContent | null {
	if (current?.status === "clean") return null;
	const matched =
		current?.source === "current_diff" &&
		current.status === "matching_evidence" &&
		current.actor &&
		!!current.baselineVersion &&
		!current.reason;
	const labels = matched ? buildAttributionLabels(current.actor, t) : null;
	const tooltipLines = [
		labels
			? t("attributionCurrentMatched", { name: labels.detail })
			: t("attributionCurrentUnknown"),
	];
	if (current) {
		tooltipLines.push(
			t("attributionCurrentTarget", {
				target: t(current.target === "index" ? "staged" : "unstaged"),
			}),
		);
		if (current.baselineVersion)
			tooltipLines.push(
				t("attributionBaselineVersion", { version: current.baselineVersion.slice(0, 12) }),
			);
		if (current.reason) tooltipLines.push(t(`attributionCurrentReason.${current.reason}`));
		if (!current.historyComplete) tooltipLines.push(t("attributionHistoryTruncated"));
		if (current.modeScope === "git_executable_bit") tooltipLines.push(t("attributionIndexMode"));
	}
	tooltipLines.push(t("attributionContinuityUnknown"));
	tooltipLines.push(t("attributionNotCurrentOwnership"));
	if (history) {
		tooltipLines.push(t("attributionHistorySection"));
		tooltipLines.push(...buildAttributionBadge(history, t).tooltipLines);
	}
	return {
		label: labels
			? t("attributionEvidenceBadge", { name: labels.short })
			: t("attributionCurrentUnknownBadge"),
		// A current target never displays a '+N contributors' suffix from historical rows.
		extraCount: 0,
		extraCountIsLowerBound: false,
		incomplete: !matched,
		tooltipLines,
		hasNarrator: !!matched && attributionLabelKind(current.actor) === "narrator",
	};
}
