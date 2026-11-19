import type { ReasoningTranslationGroup } from "@shared/pretext-layout/reasoning-translation-sources";
import { IconLanguage } from "@tabler/icons-react";
import classes from "./reasoning-translation-indicator.module.css";
import { useReasoningTranslationStatus } from "./reasoning-translation-status-store";

/** Only this 12px slot subscribes; translation progress cannot rebuild or measure a document. */
export function ReasoningTranslationIndicator({
	narratorId,
	group,
	label = "Translating reasoning",
}: {
	narratorId?: string;
	group?: ReasoningTranslationGroup;
	label?: string;
}) {
	const state = useReasoningTranslationStatus(narratorId, group?.groupId);
	if (!state) return null;
	return (
		<span
			className={classes.indicator}
			role="img"
			aria-label={label}
			data-reasoning-translation-status={state}
			data-vlist-copy-ignore=""
		>
			<IconLanguage size={12} aria-hidden="true" />
		</span>
	);
}
