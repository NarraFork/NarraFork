import { IconBrain } from "@tabler/icons-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { CollapsibleTrace } from "./CollapsibleTrace";
import { MarkdownContent } from "./MarkdownContent";
import type { ReasoningSegment } from "./reasoning-segments";

// Keep the most recent N step titles visible; earlier ones collapse behind a
// "show earlier" toggle. Matches the product decision to render reasoning as a
// live trace with titles always visible.
const MAX_VISIBLE_TITLES = 5;

/** Derive a short display title for a step (untitled steps use body head). */
function displayTitle(segment: ReasoningSegment): string {
	if (segment.title != null && segment.title.length > 0) return segment.title;
	const firstLine = segment.body.split("\n").find((l) => l.trim().length > 0) ?? "";
	const trimmed = firstLine.trim();
	return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

export const ReasoningStepsTrace = memo(function ReasoningStepsTrace({
	segments,
	streaming,
	persistKeyBase,
}: {
	segments: ReasoningSegment[];
	streaming?: boolean;
	persistKeyBase?: string;
}) {
	const { t } = useTranslation("narrator");
	const lastIndex = segments.length - 1;

	if (segments.length === 0) return null;

	return (
		<CollapsibleTrace
			items={segments.map((segment, i) => ({
				key: `seg${i}`,
				title: displayTitle(segment),
				body:
					!segment.isEmpty && segment.body.trim().length > 0 ? (
						<MarkdownContent text={segment.body} />
					) : null,
				shimmer: streaming && i === lastIndex,
			}))}
			headerIcon={<IconBrain size={10} />}
			headerColor="grape"
			headerLabel={t("reasoning")}
			headerCount={t("reasoningSteps", { count: segments.length })}
			maxVisible={MAX_VISIBLE_TITLES}
			persistKeyBase={persistKeyBase}
			showEarlierLabel={(n) => t("reasoningShowEarlier", { count: n })}
			hideEarlierLabel={t("reasoningHideEarlier")}
		/>
	);
});
