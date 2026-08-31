import { Alert, Button, Checkbox, Modal, Stack, Text } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import {
	extractCleanupErrors,
	extractSkippedIds,
	showOperationWarnings,
} from "../../lib/operation-warnings";
import { useConfirmDialog } from "../common/confirm-dialog-context";

const MAX_CHAPTER_CLEANUP_LABEL_CHARS = 500;

function clampCleanupLabel(value: string): string {
	return value.length > MAX_CHAPTER_CLEANUP_LABEL_CHARS
		? `${value.slice(0, MAX_CHAPTER_CLEANUP_LABEL_CHARS)}…`
		: value;
}

interface ChapterCleanupModalProps {
	chapters: Array<{ id: string; title: string; status: string }>;
	opened: boolean;
	onClose: () => void;
}

export function ChapterCleanupModal({ chapters, opened, onClose }: ChapterCleanupModalProps) {
	const [selected, setSelected] = useState<string[]>([]);
	const [force, setForce] = useState(false);
	const [deleteBranch, setDeleteBranch] = useState(false);
	const qc = useQueryClient();
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");
	const confirm = useConfirmDialog();

	const resetState = () => {
		setSelected([]);
		setForce(false);
		setDeleteBranch(false);
	};

	const handleClose = () => {
		resetState();
		onClose();
	};

	const titleOf = (chapterId: string): string =>
		clampCleanupLabel(chapters.find((ch) => ch.id === chapterId)?.title ?? chapterId);

	const cleanup = useMutation({
		mutationFn: () =>
			api.cleanupChapters({
				chapterIds: selected,
				force,
				deleteBranch,
			}),
		onSuccess: (result) => {
			// The report distinguishes cleaned from skipped and failed chapters, and the
			// request succeeds either way. Closing the modal on success used to swallow
			// both lists, so a cleanup that did nothing looked identical to one that
			// removed everything. Skipped chapters are named by id only, so resolve the
			// titles here from the list the user selected from.
			const skipped = extractSkippedIds(result);
			const errors = extractCleanupErrors(result);
			const lines = [
				...skipped.map((id) => t("cleanupSkippedItem", { title: titleOf(id) })),
				...errors.map((entry) =>
					t("cleanupErrorItem", {
						title: titleOf(entry.chapterId),
						error: entry.error || tc("unknownError"),
					}),
				),
			];
			if (skipped.length > 0) lines.push(t("cleanupSkippedReason"));
			showOperationWarnings(t("cleanupSkippedTitle"), lines);
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["graph"] });
			// Cleanup removes worktrees and branches, so the story network and the timeline
			// are as stale afterwards as they are after a merge — and they were being left
			// alone, which kept both views showing the chapter as active until something
			// else happened to refetch them. Same set as `ChapterMergeModal`.
			qc.invalidateQueries({ queryKey: ["narraFlow"] });
			qc.invalidateQueries({ queryKey: ["ruler"] });
			qc.invalidateQueries({ queryKey: ["rulerSegment"] });
			qc.invalidateQueries({ queryKey: ["chapterEdges"] });
			handleClose();
		},
	});

	const toggleChapter = (id: string) => {
		setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
	};

	const handleCleanup = async () => {
		if (force || deleteBranch) {
			const confirmed = await confirm({
				title: t("cleanupConfirmTitle"),
				message: (
					<Stack gap={4}>
						<Text size="sm">{t("cleanupConfirmMessage", { count: selected.length })}</Text>
						<Text size="sm">
							{t("cleanupConfirmForce", { value: force ? tc("yes") : tc("no") })}
						</Text>
						<Text size="sm">
							{t("cleanupConfirmDeleteBranch", {
								value: deleteBranch ? tc("yes") : tc("no"),
							})}
						</Text>
					</Stack>
				),
				confirmLabel: t("cleanupConfirmButton"),
				confirmColor: "red",
			});
			if (!confirmed) return;
		}
		cleanup.mutate();
	};

	// Only show chapters that can be cleaned up
	const cleanable = chapters.filter((ch) => ch.status === "active" || ch.status === "dormant");

	return (
		<Modal opened={opened} onClose={handleClose} title={t("batchCleanup")}>
			<Stack>
				<Text size="sm" c="dimmed">
					{t("cleanupDescription")}
				</Text>
				{cleanable.map((ch) => (
					<Checkbox
						key={ch.id}
						label={clampCleanupLabel(ch.title)}
						checked={selected.includes(ch.id)}
						onChange={() => toggleChapter(ch.id)}
					/>
				))}
				{cleanable.length === 0 && (
					<Text c="dimmed" size="sm">
						{t("noCleanupChapters")}
					</Text>
				)}
				<Checkbox
					label={t("forceCleanup")}
					checked={force}
					onChange={(e) => setForce(e.currentTarget.checked)}
				/>
				<Checkbox
					label={t("deleteBranches")}
					checked={deleteBranch}
					onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
				/>
				{cleanup.isError && (
					<Alert color="red" title={t("cleanupFailed")}>
						<Text size="sm">
							{cleanup.error instanceof Error ? cleanup.error.message : tc("unknownError")}
						</Text>
					</Alert>
				)}
				<Button
					color="red"
					onClick={handleCleanup}
					loading={cleanup.isPending}
					disabled={selected.length === 0}
				>
					{t("cleanupCount", { count: selected.length })}
				</Button>
			</Stack>
		</Modal>
	);
}
