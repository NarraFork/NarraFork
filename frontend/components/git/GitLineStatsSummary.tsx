import { Group, Text, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { GitLineStats } from "../../../shared/git-line-stats";
import type { ApiError } from "../../lib/api";

/** Refresh measured totals silently; unknown and failed are never zero. */
export function GitLineStatsSummary({
	data,
	error,
	compact = false,
}: {
	data?: Omit<GitLineStats, "files">;
	error: Error | null;
	compact?: boolean;
}) {
	const { t } = useTranslation("git");
	const message = error
		? t(
				(error as ApiError).data?.code === "GIT_LINE_STATS_UNSUPPORTED"
					? "lineStats.unsupported"
					: "lineStats.failed",
			)
		: !data
			? t("lineStats.loading")
			: undefined;
	if (message)
		return (
			<Tooltip label={message}>
				<Text span size="xs" c="dimmed" role="status" aria-label={message}>
					{compact && !error ? "…" : message}
				</Text>
			</Tooltip>
		);
	if (!data) return null;
	return (
		<Group gap={5} wrap="nowrap">
			<Text span size="xs" c="green" fw={600}>
				+{data.linesAdded}
			</Text>
			<Text span size="xs" c="red" fw={600}>
				-{data.linesRemoved}
			</Text>
			{!data.complete && (
				<Tooltip label={t("lineStats.partial")}>
					<Text span size="xs" c="dimmed" aria-label={t("lineStats.partial")}>
						{compact ? "≈" : t("lineStats.partial")}
					</Text>
				</Tooltip>
			)}
		</Group>
	);
}
