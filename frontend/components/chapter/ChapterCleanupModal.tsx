import { Alert, Button, Checkbox, Modal, Stack, Text } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

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

	const resetState = () => {
		setSelected([]);
		setForce(false);
		setDeleteBranch(false);
	};

	const handleClose = () => {
		resetState();
		onClose();
	};

	const cleanup = useMutation({
		mutationFn: () =>
			api.cleanupChapters({
				chapterIds: selected,
				force,
				deleteBranch,
			}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["graph"] });
			handleClose();
		},
	});

	const toggleChapter = (id: string) => {
		setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
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
						label={ch.title}
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
					onClick={() => cleanup.mutate()}
					loading={cleanup.isPending}
					disabled={selected.length === 0}
				>
					{t("cleanupCount", { count: selected.length })}
				</Button>
			</Stack>
		</Modal>
	);
}
