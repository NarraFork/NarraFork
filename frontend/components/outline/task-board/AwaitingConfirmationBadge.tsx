/**
 * The status bar's badge for goals whose completion waits for a person (outline P2 PR 5: a locked
 * goal the agent ticked done, D26b). It says "your confirmation" only to someone who decides one
 * of them (its locker, or the person of the session confirming for them); everyone else reads
 * that goals wait for confirmation (review round 1). A click opens the task board.
 */
import { Badge, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

export interface AwaitingConfirmationCounts {
	/** Goals of the session whose completion waits for confirmation. */
	total: number;
	/** Of those, the ones the viewer decides. */
	yours: number;
}

/** The badge's text, or null when nothing waits. */
export function awaitingConfirmationText(
	counts: AwaitingConfirmationCounts | null | undefined,
	t: (key: string, options: { count: number }) => string,
): string | null {
	if (!counts || counts.total <= 0) return null;
	return counts.yours > 0
		? t("board.statusBar.awaitingYou", { count: counts.yours })
		: t("board.statusBar.awaitingOthers", { count: counts.total });
}

export function AwaitingConfirmationBadge({
	counts,
	onOpen,
}: {
	counts: AwaitingConfirmationCounts | null | undefined;
	onOpen?: () => void;
}) {
	const { t } = useTranslation("outline");
	const text = awaitingConfirmationText(counts, t);
	if (!text) return null;
	const yours = (counts?.yours ?? 0) > 0;
	return (
		<UnstyledButton
			onClick={onOpen}
			style={{ flexShrink: 0 }}
			data-testid="status-awaiting-confirmation"
			data-yours={yours ? "true" : "false"}
		>
			<Badge size="xs" color={yours ? "orange" : "gray"} variant="light" tt="none">
				{text}
			</Badge>
		</UnstyledButton>
	);
}
