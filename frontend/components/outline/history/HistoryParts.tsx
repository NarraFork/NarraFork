/**
 * Small pieces the history screens share (pageless outline, F2): a comparison's mark on a row
 * (an icon on its tinted ground, never a character), what a failed call means in words, and a
 * block's one line as an entry of a comparison or a change list shows it.
 */
import { Badge, Tooltip } from "@mantine/core";
import { blockTitle } from "@shared/outline";
import type { OutlineDiffEntry, OutlineDiffKind } from "@shared/outline-restore-api";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { describeApiError } from "../../../lib/api-error";
import { DIFF_ICONS, DIFF_TONE } from "../outline-icons";
import type { HistoryProblem } from "./history-model";

/**
 * What a comparison says happened to a block: its kind's icon on a light badge of its colour.
 * `label` (a tooltip, and what assistive technology reads) says it in words.
 */
export function OutlineDiffMark({
	kind,
	label,
	testId = "outline-diff-mark",
}: {
	kind: OutlineDiffKind;
	label: string;
	testId?: string;
}) {
	const { Icon } = DIFF_ICONS[kind];
	return (
		<Tooltip label={label} openDelay={300}>
			<Badge
				size="xs"
				variant="light"
				color={DIFF_TONE[kind]}
				tt="none"
				px={3}
				role="img"
				aria-label={label}
				data-testid={testId}
				data-diff={kind}
			>
				<Icon size={11} stroke={2.5} aria-hidden style={{ display: "block" }} />
			</Badge>
		</Tooltip>
	);
}

/** A block's first line from an entry (the newer side, else the older), or "(empty)". */
export function entryLine(entry: Pick<OutlineDiffEntry, "before" | "after">, t: TFunction): string {
	const side = entry.after ?? entry.before;
	const line = side ? blockTitle(side.excerpt).trim() : "";
	return line || t("diff.untitled", { ns: "outline" });
}

/** A failed call of history in words. */
export function problemText(problem: HistoryProblem, t: TFunction): string {
	switch (problem.kind) {
		case "conflict":
			return problem.conflictSeq !== null
				? t("restore.problem.conflict", { ns: "outline", seq: problem.conflictSeq })
				: t("restore.problem.conflictNoSeq", { ns: "outline" });
		case "before-floor":
			return t("restore.problem.before-floor", { ns: "outline", seq: problem.floorSeq ?? 0 });
		case "other":
			return describeApiError(problem.error, t).message;
		default:
			return t(`restore.problem.${problem.kind}`, { ns: "outline" });
	}
}

/** {@link problemText} for a component. */
export function useProblemText(): (problem: HistoryProblem) => string {
	const { t } = useTranslation("outline");
	return (problem) => problemText(problem, t);
}
