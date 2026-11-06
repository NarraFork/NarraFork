/**
 * A submitted plan against the version it is compared with (outline P2 PR 8, D48 Q5): the blocks
 * that changed, in tree order, each with what changed and its text before and after. Fetched when
 * opened and again whenever the plan's page changes (`useOutlinePlanDiff`: the person may be
 * editing it in the outline beside the session), so the version a decision names (`seenSeq`) is
 * the one on screen.
 */

import { Alert, Badge, Group, Loader, Modal, Paper, ScrollArea, Stack, Text } from "@mantine/core";
import type {
	OutlinePlanDiffEntry,
	OutlinePlanDiffResponse,
	OutlinePlanTaskView,
} from "@shared/outline-api";
import type { ReactNode } from "react";
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

function DiffRow({ entry }: { entry: OutlinePlanDiffEntry }) {
	const { t } = useTranslation("narrator");
	const added = entry.changes.includes("added");
	const removed = entry.changes.includes("removed");
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
				<Text size="xs" c="dimmed" td="line-through" style={{ whiteSpace: "pre-wrap" }}>
					{entry.before}
				</Text>
			)}
			{removed ? (
				<Text size="xs" c="red" td="line-through" style={{ whiteSpace: "pre-wrap" }}>
					{entry.before}
				</Text>
			) : (
				<Text size="xs" c={added ? "green" : undefined} style={{ whiteSpace: "pre-wrap" }}>
					{entry.after}
				</Text>
			)}
			{entry.changes.includes("task") && (
				<Text size="xs" c="grape">
					{taskLine(t, entry.taskBefore)} → {taskLine(t, entry.taskAfter)}
				</Text>
			)}
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
	footer,
}: {
	opened: boolean;
	onClose: () => void;
	title: string;
	diff: OutlinePlanDiffResponse | undefined;
	loading: boolean;
	error: unknown;
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
				<OutlinePlanDiffBody diff={diff} loading={loading} error={error} />
			</ScrollArea.Autosize>
			<div style={{ marginTop: "var(--mantine-spacing-sm)" }}>{footer}</div>
		</Modal>
	);
}
