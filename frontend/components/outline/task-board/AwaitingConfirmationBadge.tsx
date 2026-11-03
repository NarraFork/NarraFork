/**
 * The status bar's badge for goals whose completion waits for a person (outline P2 PR 5: a locked
 * goal the agent ticked done, D26b). It says "your confirmation" only to the person who decides
 * one of them on the board (its locker); everyone else reads whose confirmation they wait for
 * (review rounds 1 and 2), or that they wait for confirmation. A click opens the task board.
 */
import { Badge, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";

export interface AwaitingConfirmationCounts {
	/** Goals of the session whose completion waits for confirmation. */
	total: number;
	/** Of those, the ones the viewer decides. */
	yours: number;
	/** Who decides the others (usernames). */
	from?: readonly string[];
}

/** The badge's text, or null when nothing waits. */
export function awaitingConfirmationText(
	counts: AwaitingConfirmationCounts | null | undefined,
	t: (key: string, options: { count: number; names?: string }) => string,
): string | null {
	if (!counts || counts.total <= 0) return null;
	if (counts.yours > 0) return t("board.statusBar.awaitingYou", { count: counts.yours });
	if (counts.from && counts.from.length > 0)
		return t("board.statusBar.awaitingFrom", {
			count: counts.total,
			names: counts.from.join(", "),
		});
	return t("board.statusBar.awaitingOthers", { count: counts.total });
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
