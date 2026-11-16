/**
 * The bar over a block (or the whole space) shown as it was at a point of its history
 * (pageless outline, F2): it says so plainly, goes back to now, opens what changed since (or
 * up to a later point: `OutlineDiffList`, whose rows the host marks in the forest as of then),
 * and — for people who may change the space — asks the host to restore the subtree to this
 * point (`onRestore`: the host keeps the restore dialog, `OutlineRestoreModal`, so that moving
 * through history meanwhile neither changes nor ends it). People who may only read see the
 * history and the comparison.
 */
import { Badge, Box, Button, Group, NativeSelect, Paper, Text } from "@mantine/core";
import type { OutlineDiffKind } from "@shared/outline-restore-api";
import { IconArrowBackUp, IconClock, IconGitCompare, IconRestore } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineSubtreeTimeline } from "../../../hooks/useOutline";
import { formatSmartTime } from "../../../lib/format";
import { timelineOldestFirst } from "../../../lib/outline-view";
import classes from "../Outline.module.css";
import { commitActorLabel } from "../OutlineTimeline";
import { OutlineDiffList } from "./OutlineDiffList";

/** Commits a "compare with" list offers at most (the newest after the point). */
const COMPARE_CHOICES = 50;

export function OutlineHistoryBar({
	spaceId,
	rootId,
	asOf,
	canWrite,
	onBack,
	onMarks,
	onRestore,
}: {
	spaceId: string;
	/** The block shown; null: the whole space. */
	rootId: string | null;
	/** The point shown. */
	asOf: number;
	canWrite: boolean;
	/** Back to now. */
	onBack: () => void;
	/** What the comparison names in the forest as of `asOf` (empty when it is closed). */
	onMarks?: (marks: ReadonlyMap<string, OutlineDiffKind>) => void;
	/** Restore the subtree to `asOf` (the host opens its restore dialog). */
	onRestore?: (thenSeq: number) => void;
}) {
	const { t } = useTranslation("outline");
	const [comparing, setComparing] = useState(false);
	const [to, setTo] = useState<number | undefined>(undefined);
	// The same query as the timeline strip: the commit shown, and the later ones to compare with.
	const timeline = useOutlineSubtreeTimeline(spaceId, rootId);
	const commits = useMemo(() => timelineOldestFirst(timeline.data?.pages ?? []), [timeline.data]);
	const commit = commits.find((c) => c.seq === asOf) ?? null;
	const later = useMemo(
		() =>
			commits
				.filter((c) => c.seq > asOf)
				.slice(-COMPARE_CHOICES)
				.reverse(),
		[commits, asOf],
	);
	const toShown = to !== undefined && to > asOf ? to : undefined;
	return (
		<Box mb="xs" data-testid="outline-history-bar">
			<Paper withBorder radius="sm" p={8} className={classes.historyBar} role="status">
				<Group gap={8} wrap="nowrap" align="flex-start">
					<IconClock size={16} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden />
					<Box style={{ minWidth: 0, flex: 1 }}>
						<Group gap={6} wrap="wrap">
							<Text size="sm" fw={500} data-testid="outline-history-banner">
								{t("asOf.banner", { seq: asOf })}
							</Text>
							<Badge size="xs" variant="outline" color="gray" tt="none">
								{t("asOf.readOnly")}
							</Badge>
						</Group>
						{commit && (
							<Text size="xs" c="dimmed" className={classes.ellipsis}>
								{[commitActorLabel(commit, t), formatSmartTime(commit.createdAt), commit.summary]
									.filter(Boolean)
									.join(" · ")}
							</Text>
						)}
					</Box>
				</Group>
				<Group gap={6} mt={6} wrap="wrap">
					<Button
						size="compact-sm"
						variant="filled"
						leftSection={<IconArrowBackUp size={14} />}
						onClick={onBack}
						data-testid="outline-history-now"
					>
						{t("asOf.backToNow")}
					</Button>
					<Button
						size="compact-sm"
						variant={comparing ? "light" : "default"}
						leftSection={<IconGitCompare size={14} />}
						aria-pressed={comparing}
						onClick={() => setComparing(!comparing)}
						data-testid="outline-history-compare"
					>
						{t(comparing ? "asOf.hideCompare" : "asOf.compare")}
					</Button>
					{canWrite && onRestore && (
						<Button
							size="compact-sm"
							variant="light"
							color="orange"
							leftSection={<IconRestore size={14} />}
							onClick={() => onRestore(asOf)}
							data-testid="outline-history-restore"
						>
							{t("asOf.restore")}
						</Button>
					)}
				</Group>
				{!canWrite && (
					<Text size="xs" c="dimmed" mt={4} data-testid="outline-history-read-only">
						{t("asOf.readOnlyHint")}
					</Text>
				)}
			</Paper>
			{comparing && (
				<Paper withBorder radius="sm" p={8} mt={6}>
					{later.length > 0 && (
						<NativeSelect
							size="xs"
							mb={6}
							label={t("diff.compareWith")}
							value={toShown === undefined ? "now" : String(toShown)}
							onChange={(event) => {
								const value = event.currentTarget.value;
								setTo(value === "now" ? undefined : Number(value));
							}}
							data={[
								{ value: "now", label: t("diff.now") },
								...later.map((c) => ({
									value: String(c.seq),
									label: [t("timeline.commit", { seq: c.seq }), c.summary]
										.filter(Boolean)
										.join(" · ")
										.slice(0, 80),
								})),
							]}
							className={classes.compareSelect}
							data-testid="outline-diff-to"
						/>
					)}
					<OutlineDiffList
						spaceId={spaceId}
						rootId={rootId}
						thenSeq={asOf}
						to={toShown}
						onMarks={onMarks}
					/>
				</Paper>
			)}
		</Box>
	);
}
