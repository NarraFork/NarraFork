/**
 * The history of a block's subtree as a list (the side panel's History tab, pageless outline
 * F2): the commits that changed the block or anything under it, newest first, a page at a time
 * down to the space's history floor. Each says what, who and when; picking one shows the subtree
 * as it was then (the same as the timeline strip, which reads the same query).
 */
import { Alert, Badge, Button, Group, Loader, Stack, Text, UnstyledButton } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineSubtreeTimeline } from "../../../hooks/useOutline";
import { formatFullLocaleDateTime, formatSmartTime } from "../../../lib/format";
import classes from "../Outline.module.css";
import { commitActorLabel } from "../OutlineTimeline";
import { problemText } from "./HistoryParts";
import { historyProblemOf } from "./history-model";

export function OutlineHistoryList({
	spaceId,
	rootId,
	asOf,
	onViewAt,
}: {
	spaceId: string;
	rootId: string | null;
	asOf: number | undefined;
	onViewAt: (seq: number) => void;
}) {
	const { t } = useTranslation("outline");
	const timeline = useOutlineSubtreeTimeline(spaceId, rootId);
	const commits = useMemo(
		() => timeline.data?.pages.flatMap((page) => page.commits) ?? [],
		[timeline.data],
	);
	const floorSeq = timeline.data?.pages.at(-1)?.floorSeq ?? 0;
	return (
		<Stack gap={2} data-testid="outline-history-list">
			{timeline.isLoading && <Loader size="sm" />}
			{timeline.isError && (
				<Alert color="gray" variant="light">
					{problemText(historyProblemOf(timeline.error), t)}
				</Alert>
			)}
			{timeline.isSuccess && commits.length === 0 && (
				<Text size="sm" c="dimmed">
					{t("timeline.empty")}
				</Text>
			)}
			{commits.map((commit) => (
				<UnstyledButton
					key={commit.seq}
					className={classes.listItem}
					data-selected={asOf === commit.seq}
					data-history-seq={commit.seq}
					aria-current={asOf === commit.seq ? "true" : undefined}
					title={formatFullLocaleDateTime(commit.createdAt)}
					aria-label={t("timeline.view", { seq: commit.seq })}
					onClick={() => onViewAt(commit.seq)}
				>
					<Group gap={4} wrap="wrap">
						<Text size="xs" fw={500}>
							{t("timeline.commit", { seq: commit.seq })}
						</Text>
						<Badge size="xs" variant="light" tt="none">
							{t(`timeline.kind.${commit.kind}`)}
						</Badge>
					</Group>
					<Text size="xs" c="dimmed" className={classes.ellipsis}>
						{[commitActorLabel(commit, t), formatSmartTime(commit.createdAt), commit.summary]
							.filter(Boolean)
							.join(" · ")}
					</Text>
				</UnstyledButton>
			))}
			{timeline.hasNextPage && (
				<Button
					variant="subtle"
					size="compact-xs"
					mt={4}
					loading={timeline.isFetchingNextPage}
					onClick={() => void timeline.fetchNextPage()}
					data-testid="outline-history-more"
				>
					{t("loadMore")}
				</Button>
			)}
			{timeline.isSuccess && !timeline.hasNextPage && floorSeq > 0 && (
				<Text size="xs" c="dimmed" mt={4}>
					{t("timeline.floor")}
				</Text>
			)}
		</Stack>
	);
}
