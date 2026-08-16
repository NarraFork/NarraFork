/**
 * Display labels for file attribution actors.
 *
 * A worktree is written by more than the chapter's own primary narrators: subagents,
 * standalone narrators and narrators from other chapters all share the directory.
 * The server resolves each contributor, so this module only decides how to phrase
 * one — kept pure and separate from the panel so the phrasing is testable and the
 * badge and its tooltip cannot drift apart.
 */
import type { AttributionActor, FileModificationGroup } from "@frontend/hooks/useGit";

type Translate = (key: string, opts?: Record<string, unknown>) => string;

export interface AttributionLabels {
	/** Short form for the badge. Always non-empty. */
	short: string;
	/**
	 * Longer form for the tooltip, carrying subagent type and parent when known.
	 * Equals `short` when there is nothing more to say.
	 */
	detail: string;
}

/** Which class of contributor a label names. */
export type AttributionLabelKind = "narrator" | "external" | "deleted" | "unknown";

/**
 * Decide which class of contributor a label will name, without phrasing it.
 *
 * Exists so a badge's "+N others" count can subtract exactly the class the label is
 * already showing. The two used to decide independently, which double-counted the
 * displayed contributor; deriving both from this one function means a change to the
 * precedence below cannot leave the count behind.
 */
export function attributionLabelKind(
	actor: AttributionActor | null | undefined,
	options: { external?: boolean; deleted?: boolean } = {},
): AttributionLabelKind {
	if (!actor) {
		// External wins when both were recorded: it is the one the user can still
		// investigate, whereas a deleted session is a dead end.
		if (options.external) return "external";
		return options.deleted ? "deleted" : "unknown";
	}
	// An id that resolved to a missing narrator row is the same deleted-session case,
	// seen from a row that still carries the id.
	return actor.exists ? "narrator" : "deleted";
}

/**
 * Phrase one actor.
 *
 * `null` means the row carried no narrator id, which has two distinct causes: an
 * external / terminal edit, or a tool change whose session was later deleted (the
 * FK is `ON DELETE SET NULL`). The caller says which via `options`, because
 * collapsing both into "unknown" is what made the badge uninformative.
 *
 * An actor with `exists: false` is the same deleted-session case, seen from a row
 * that still carries the id.
 */
export function buildAttributionLabels(
	actor: AttributionActor | null | undefined,
	t: Translate,
	options: { external?: boolean; deleted?: boolean } = {},
): AttributionLabels {
	// Everything that is not a live narrator is a single flat label, and which one it
	// is comes from `attributionLabelKind` so the badge's count agrees with it.
	if (!actor?.exists) {
		const kind = attributionLabelKind(actor, options);
		const label =
			kind === "external"
				? t("attributionExternal")
				: kind === "deleted"
					? t("attributionDeletedSession")
					: t("attributionUnknown");
		return { short: label, detail: label };
	}

	const name = actor.title?.trim() || null;

	if (!actor.subagentType) {
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

/** Everything the attribution badge renders, decided in one place. */
export interface AttributionBadgeContent {
	/** Badge caption: the named contributor. */
	label: string;
	/**
	 * Contributors NOT named by `label`.
	 *
	 * Zero when the named contributor is the only one — the count and the label are
	 * derived together here precisely so a lone external or deleted contributor cannot
	 * be rendered as "External +1".
	 */
	extraCount: number;
	/** Tooltip lines, already phrased, in display order. */
	tooltipLines: string[];
	/** Whether the named contributor resolved to a live narrator. */
	hasNarrator: boolean;
}

/**
 * Compose the badge for one file's attribution rollup.
 *
 * Pure and separate from the panel so the caption, the "+N" and the tooltip are one
 * decision rather than three. They used to be computed independently in the component,
 * and drifted: `hasExternalChange` both selected the caption AND incremented the count,
 * so a file touched only by an external edit claimed two contributors, and a deleted
 * `lastActor` was re-listed by the tooltip as if it were somebody else.
 */
export function buildAttributionBadge(
	attribution: FileModificationGroup,
	t: Translate,
): AttributionBadgeContent {
	const lastActor = attribution.lastActor;
	const hasNarratorId = !!lastActor?.narratorId;
	// With no narrator id the change is either an external edit or a deleted session's
	// leftover (the FK is nulled on delete); both are reported and the precedence between
	// them is settled by `attributionLabelKind`.
	const options = {
		external: !hasNarratorId && attribution.hasExternalChange,
		deleted: !hasNarratorId && attribution.hasDeletedActor,
	};
	const actor = hasNarratorId ? lastActor : null;
	const labels = buildAttributionLabels(actor, t, options);
	const kind = attributionLabelKind(actor, options);

	// Contributors other than the one the caption names.
	const others = attribution.actors.filter(
		(candidate) => candidate.narratorId && candidate.narratorId !== lastActor?.narratorId,
	);
	// A flag is extra information only when the caption is not already showing it.
	const showsExternal = attribution.hasExternalChange && kind !== "external";
	const showsDeleted = attribution.hasDeletedActor && kind !== "deleted";

	const tooltipLines = [t("attributionLastModified", { name: labels.detail })];
	for (const candidate of others) {
		tooltipLines.push(
			t("attributionAlsoModified", { name: buildAttributionLabels(candidate, t).detail }),
		);
	}
	if (showsExternal) tooltipLines.push(t("attributionHasExternal"));
	if (showsDeleted) {
		tooltipLines.push(t("attributionAlsoModified", { name: t("attributionDeletedSession") }));
	}
	// A shell command's write set is not provably its own, so the badge must not present a
	// guess with the same confidence as a recorded file write.
	if (attribution.hasImpreciseAttribution) tooltipLines.push(t("attributionImprecise"));

	return {
		label: labels.short,
		extraCount: others.length + (showsExternal ? 1 : 0) + (showsDeleted ? 1 : 0),
		tooltipLines,
		hasNarrator: kind === "narrator",
	};
}
