/**
 * What differs under a block (or in the whole space) between a point of its history and now,
 * or two points (pageless outline, F2, on H3 `diff`): one row per block that was added,
 * deleted, moved in, moved away or changed, with what changed (place, order, text, task,
 * question, alias, tags) and the text's start on each side. Paged: "Show more changes" reads
 * the next page of the same comparison. The blocks it names that were there then are handed to
 * the host (`onMarks`), which marks them in the forest as of that point.
 */
import { Alert, Anchor, Box, Group, Loader, Stack, Text } from "@mantine/core";
import { blockTitle } from "@shared/outline";
import type { OutlineDiffEntry, OutlineDiffKind } from "@shared/outline-restore-api";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineSubtreeDiff } from "../../../hooks/useOutline";
import classes from "../Outline.module.css";
import { OutlineLink, outlineBlockTarget } from "../outline-nav";
import { entryLine, OutlineDiffMark, problemText } from "./HistoryParts";
import { diffEntriesOf, diffMarksOf, historyProblemOf } from "./history-model";

export function OutlineDiffList({
	spaceId,
	rootId,
	thenSeq,
	to,
	onMarks,
}: {
	spaceId: string;
	rootId: string | null;
	/** The older point. */
	thenSeq: number;
	/** The newer point; absent: now. */
	to?: number;
	/** The blocks of the forest as of `thenSeq` the comparison names, as its pages arrive. */
	onMarks?: (marks: ReadonlyMap<string, OutlineDiffKind>) => void;
}) {
	const { t } = useTranslation("outline");
	const diff = useOutlineSubtreeDiff(spaceId, rootId, thenSeq, to, true);
	const pages = diff.data?.pages;
	const entries = useMemo(() => diffEntriesOf(pages ?? []), [pages]);
	useEffect(() => {
		onMarks?.(diffMarksOf(pages ?? []));
	}, [pages, onMarks]);
	useEffect(() => () => onMarks?.(new Map()), [onMarks]);
	const nowSeq = pages?.[0]?.nowSeq;
	return (
		<Box className={classes.diffList} data-testid="outline-diff">
			<Text size="sm" fw={500} mb={4}>
				{to !== undefined
					? t("diff.titleTo", { from: thenSeq, to })
					: t("diff.titleNow", { from: thenSeq })}
				{to === undefined && nowSeq !== undefined && (
					<Text span size="xs" c="dimmed" ml={6}>
						{t("timeline.commit", { seq: nowSeq })}
					</Text>
				)}
			</Text>
			{diff.isLoading && <Loader size="sm" />}
			{diff.isError && (
				<Alert color="gray" variant="light" py={6}>
					{problemText(historyProblemOf(diff.error), t)}
				</Alert>
			)}
			{diff.isSuccess && entries.length === 0 && !diff.hasNextPage && (
				<Text size="sm" c="dimmed" data-testid="outline-diff-empty">
					{t("diff.empty")}
				</Text>
			)}
			<Stack gap={2}>
				{entries.map((entry) => (
					<DiffRow key={entry.blockId} entry={entry} spaceId={spaceId} thenSeq={thenSeq} />
				))}
			</Stack>
			{diff.hasNextPage && (
				<Box mt={4}>
					<Anchor
						component="button"
						type="button"
						size="sm"
						onClick={() => void diff.fetchNextPage()}
						disabled={diff.isFetchingNextPage}
						data-testid="outline-diff-more"
					>
						{t("diff.more")}
					</Anchor>
					{diff.isFetchingNextPage && <Loader size={12} ml={6} />}
				</Box>
			)}
		</Box>
	);
}

function DiffRow({
	entry,
	spaceId,
	thenSeq,
}: {
	entry: OutlineDiffEntry;
	spaceId: string;
	thenSeq: number;
}) {
	const { t } = useTranslation("outline");
	const label = entry.deletedSince ? t("diff.movedAwayDeleted") : t(`diff.kind.${entry.kind}`);
	const line = entryLine(entry, t);
	// Where it is now; a deleted one as it was then.
	const to = entry.after
		? outlineBlockTarget(spaceId, entry.blockId)
		: outlineBlockTarget(spaceId, entry.blockId, undefined, thenSeq);
	const fields = entry.fields.filter((field) => field !== "text");
	const textChanged = entry.fields.includes("text") && entry.before && entry.after;
	const aliasChanged = entry.fields.includes("alias") && entry.before && entry.after;
	return (
		<Group
			gap={6}
			wrap="nowrap"
			align="flex-start"
			className={classes.historyEntry}
			data-diff-entry={entry.blockId}
			data-diff-kind={entry.kind}
		>
			<OutlineDiffMark kind={entry.kind} label={label} />
			<Box style={{ minWidth: 0, flex: 1 }}>
				<Group gap={6} wrap="nowrap">
					<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
						{label}
					</Text>
					<OutlineLink to={to} className={`${classes.ellipsis} ${classes.diffTitle}`}>
						{line}
					</OutlineLink>
				</Group>
				{entry.kind === "changed" && fields.length > 0 && (
					<Text size="xs" c="dimmed" data-diff-fields={entry.fields.join(",")}>
						{t("diff.fields", {
							fields: fields.map((field) => t(`diff.field.${field}`)).join(", "),
						})}
						{aliasChanged && ` (${entry.before?.alias ?? "–"} → ${entry.after?.alias ?? "–"})`}
					</Text>
				)}
				{textChanged && (
					<Box className={classes.historyText} data-diff-fields={entry.fields.join(",")}>
						<Text size="xs" c="dimmed" className={classes.diffBefore}>
							<Text span size="xs" fw={500} mr={4}>
								{t("diff.then")}
							</Text>
							{excerptOf(entry.before?.excerpt ?? "", entry.before?.truncated === true, t)}
						</Text>
						<Text size="xs" className={classes.diffAfter}>
							<Text span size="xs" fw={500} mr={4}>
								{t("diff.after")}
							</Text>
							{excerptOf(entry.after?.excerpt ?? "", entry.after?.truncated === true, t)}
						</Text>
					</Box>
				)}
			</Box>
		</Group>
	);
}

function excerptOf(
	text: string,
	truncated: boolean,
	t: (key: string, options?: Record<string, unknown>) => string,
): string {
	const line = text.replace(/\s+/g, " ").trim() || blockTitle(text) || t("diff.untitled");
	return truncated ? `${line}…` : line;
}
