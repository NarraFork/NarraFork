/**
 * A submitted plan against the version it is compared with (outline P2 PR 8, D48 Q5): the blocks
 * that changed, in tree order, each with what changed and its text before and after. Fetched when
 * opened and again whenever the plan's page changes (`useOutlinePlanDiff`: the person may be
 * editing it in the outline beside the session), so the version a decision names (`seenSeq`) is
 * the one on screen. A plan review's comments (PR 8b) come first, as the submission carries them;
 * the diff leaves them out.
 *
 * Nothing in the diff is folded (plan readability): it lists only the blocks that changed, each
 * at its depth under the root, so a change shows however deep it sits — unlike the plan's own
 * overview, which folds what is under its second level. A long text before or after is clamped
 * to {@link DIFF_TEXT_LINES} lines, and opens whole on a click.
 */

import {
	Alert,
	Anchor,
	Badge,
	Box,
	Group,
	Loader,
	Modal,
	Paper,
	ScrollArea,
	Stack,
	Text,
} from "@mantine/core";
import type {
	OutlinePlanDiffEntry,
	OutlinePlanDiffResponse,
	OutlinePlanReview,
	OutlinePlanTaskView,
} from "@shared/outline-api";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

function taskLine(
	t: ReturnType<typeof useTranslation>["t"],
	task: OutlinePlanTaskView | null,
): string {
	if (!task) return t("outlinePlan.diff.noTask");
	return [
		t(`outlinePlan.diff.status.${task.status}`),
		task.assignee ? `@${task.assignee}` : null,
		task.due ? t("outlinePlan.diff.due", { date: task.due }) : null,
		task.depends.length > 0 ? t("outlinePlan.diff.depends", { count: task.depends.length }) : null,
	]
		.filter(Boolean)
		.join(" · ");
}

const CHANGE_COLOR: Record<string, string> = {
	added: "green",
	removed: "red",
	text: "blue",
	task: "grape",
	moved: "gray",
};

/** Lines a changed block's text shows before it is clamped (a click shows it whole). */
const DIFF_TEXT_LINES = 3;
/** A text this long, or of more lines than the clamp, gets the "show all" toggle. */
const DIFF_TEXT_LONG = 160;

function isLongText(text: string | null): boolean {
	return !!text && (text.length > DIFF_TEXT_LONG || text.split("\n").length > DIFF_TEXT_LINES);
}

function DiffRow({ entry }: { entry: OutlinePlanDiffEntry }) {
	const { t } = useTranslation("narrator");
	const [whole, setWhole] = useState(false);
	const added = entry.changes.includes("added");
	const removed = entry.changes.includes("removed");
	const clamp = whole ? undefined : DIFF_TEXT_LINES;
	const long =
		isLongText(entry.after) ||
		(entry.changes.includes("text") || removed ? isLongText(entry.before) : false);
	return (
		<Paper
			withBorder
			p={6}
			radius="sm"
			ml={Math.min(entry.depth, 6) * 12}
			data-testid="outline-plan-diff-entry"
			data-changes={entry.changes.join(" ")}
		>
			<Group gap={4} mb={2} wrap="wrap">
				{entry.changes.map((change) => (
					<Badge key={change} size="xs" variant="light" color={CHANGE_COLOR[change] ?? "gray"}>
						{t(`outlinePlan.diff.change.${change}`)}
					</Badge>
				))}
				{(added || removed || entry.changes.includes("moved")) && entry.parentTitle && (
					<Text size="xs" c="dimmed">
						{t("outlinePlan.diff.under", { title: entry.parentTitle })}
					</Text>
				)}
			</Group>
			{entry.changes.includes("text") && entry.before !== null && (
				<Text
					size="xs"
					c="dimmed"
					td="line-through"
					lineClamp={clamp}
					style={{ whiteSpace: "pre-wrap" }}
				>
					{entry.before}
				</Text>
			)}
			{removed ? (
				<Text
					size="xs"
					c="red"
					td="line-through"
					lineClamp={clamp}
					style={{ whiteSpace: "pre-wrap" }}
				>
					{entry.before}
				</Text>
			) : (
				<Text
					size="xs"
					c={added ? "green" : undefined}
					lineClamp={clamp}
					style={{ whiteSpace: "pre-wrap" }}
					data-testid="outline-plan-diff-after"
				>
					{entry.after}
				</Text>
			)}
			{long && (
				<Anchor
					component="button"
					type="button"
					size="xs"
					onClick={() => setWhole((value) => !value)}
					data-testid="outline-plan-diff-whole"
				>
					{whole ? t("outlinePlan.diff.showLess") : t("outlinePlan.diff.showWhole")}
				</Anchor>
			)}
			{entry.changes.includes("task") && (
				<Text size="xs" c="grape">
					{taskLine(t, entry.taskBefore)} → {taskLine(t, entry.taskAfter)}
				</Text>
			)}
		</Paper>
	);
}

/** A plan review's comments, above the diff: each with the step it is about. */
export function OutlinePlanReviewComments({
	review,
	onOpen,
}: {
	review: OutlinePlanReview;
	onOpen?: () => void;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Paper
			withBorder
			p={8}
			radius="sm"
			mb="sm"
			style={{ borderColor: "var(--mantine-color-orange-light-color)" }}
			data-testid="outline-plan-review"
		>
			<Group justify="space-between" gap={6} wrap="wrap" mb={4}>
				<Text size="sm" fw={600} c="orange">
					{t("outlinePlan.review.title", { version: review.round })}
				</Text>
				{onOpen && (
					<Anchor component="button" type="button" size="xs" onClick={onOpen}>
						{t("outlinePlan.review.open")}
					</Anchor>
				)}
			</Group>
			<Text size="xs" c="dimmed" mb={6}>
				{t("outlinePlan.review.explain")}
			</Text>
			<Stack gap={6}>
				{review.comments.map((comment, index) => (
					<Box
						// The comments are a fixed list written once; their order is their identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: a static list
						key={index}
						pl={8}
						style={{ borderLeft: "2px solid var(--mantine-color-orange-light-color)" }}
						data-testid="outline-plan-review-comment"
					>
						{comment.target && (
							<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
								{t("outlinePlan.review.on", { title: comment.target.title })}
							</Text>
						)}
						<Text size="xs" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
							{comment.text}
						</Text>
					</Box>
				))}
			</Stack>
		</Paper>
	);
}

/** The diff's body: counts, then the changed blocks. */
export function OutlinePlanDiffBody({
	diff,
	loading,
	error,
}: {
	diff: OutlinePlanDiffResponse | undefined;
	loading: boolean;
	error: unknown;
}) {
	const { t } = useTranslation("narrator");
	if (loading && !diff) return <Loader size="sm" />;
	if (error && !diff)
		return (
			<Alert color="red" variant="light">
				{error instanceof Error ? error.message : String(error)}
			</Alert>
		);
	if (!diff) return null;
	const { counts } = diff;
	const nothing = counts.added + counts.removed + counts.text + counts.task + counts.moved === 0;
	return (
		<Stack gap={6} data-testid="outline-plan-diff">
			<Text size="xs" c="dimmed">
				{diff.fromSeq === 0
					? t("outlinePlan.diff.firstVersion")
					: t("outlinePlan.diff.sincePrevious")}
			</Text>
			<Group gap={6}>
				<Badge variant="light" color="green">
					{t("outlinePlan.diff.countAdded", { count: counts.added })}
				</Badge>
				<Badge variant="light" color="blue">
					{t("outlinePlan.diff.countChanged", {
						count: counts.text + counts.task + counts.moved,
					})}
				</Badge>
				<Badge variant="light" color="red">
					{t("outlinePlan.diff.countRemoved", { count: counts.removed })}
				</Badge>
			</Group>
			{nothing && (
				<Text size="sm" c="dimmed">
					{t("outlinePlan.diff.nothing")}
				</Text>
			)}
			{diff.entries.map((entry) => (
				<DiffRow key={`${entry.blockId}:${entry.changes.join(",")}`} entry={entry} />
			))}
			{diff.truncated && (
				<Text size="xs" c="dimmed">
					{t("outlinePlan.diff.truncated")}
				</Text>
			)}
		</Stack>
	);
}

export function OutlinePlanDiffModal({
	opened,
	onClose,
	title,
	diff,
	loading,
	error,
	review,
	onOpenReview,
	footer,
}: {
	opened: boolean;
	onClose: () => void;
	title: string;
	diff: OutlinePlanDiffResponse | undefined;
	loading: boolean;
	error: unknown;
	/** The plan review's comments on this version (PR 8b), shown first. */
	review?: OutlinePlanReview | null;
	onOpenReview?: () => void;
	footer: ReactNode;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t("outlinePlan.diff.title", { title })}
			size="lg"
			fullScreen={typeof window !== "undefined" && window.innerWidth < 640}
			data-testid="outline-plan-diff-modal"
		>
			<ScrollArea.Autosize mah="60vh" type="auto">
				{review && review.comments.length > 0 && (
					<OutlinePlanReviewComments review={review} onOpen={onOpenReview} />
				)}
				<OutlinePlanDiffBody diff={diff} loading={loading} error={error} />
			</ScrollArea.Autosize>
			<div style={{ marginTop: "var(--mantine-spacing-sm)" }}>{footer}</div>
		</Modal>
	);
}
