import { Alert, Button, Checkbox, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

interface ChapterBatchMergeModalProps {
	chapters: Array<{ id: string; title: string; status: string }>;
	opened: boolean;
	onClose: () => void;
}

export function ChapterBatchMergeModal({ chapters, opened, onClose }: ChapterBatchMergeModalProps) {
	const [selected, setSelected] = useState<string[]>([]);
	const [baseChapterId, setBaseChapterId] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	const [strategy, setStrategy] = useState<string>("merge");
	const qc = useQueryClient();
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");

	const resetState = () => {
		setSelected([]);
		setBaseChapterId(null);
		setTitle("");
		setStrategy("merge");
	};

	const handleClose = () => {
		resetState();
		onClose();
	};

	const batchMerge = useMutation({
		mutationFn: () =>
			api.batchMerge({
				baseChapterId: baseChapterId!,
				sourceChapterIds: selected,
				title: title.trim(),
				strategy,
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

	const activeChapters = chapters.filter((ch) => ch.status === "active");

	// Target chapter options: active chapters that are not selected as source
	const targetOptions = activeChapters
		.filter((ch) => !selected.includes(ch.id))
		.map((ch) => ({ value: ch.id, label: ch.title }));

	// Source chapter options: active chapters that are not the selected target
	const sourceChapters = activeChapters.filter((ch) => ch.id !== baseChapterId);

	return (
		<Modal opened={opened} onClose={handleClose} title={t("batchMergeTitle")}>
			<Stack>
				<Text size="sm" c="dimmed">
					{t("batchMergeDescription")}
				</Text>

				<Select
					label={t("targetChapter")}
					placeholder={t("selectTarget")}
					data={targetOptions}
					value={baseChapterId}
					onChange={setBaseChapterId}
				/>

				<Text size="sm" fw={500}>
					{t("sourceChapters")}
				</Text>
				{sourceChapters.map((ch) => (
					<Checkbox
						key={ch.id}
						label={ch.title}
						checked={selected.includes(ch.id)}
						onChange={() => toggleChapter(ch.id)}
					/>
				))}
				{sourceChapters.length === 0 && (
					<Text c="dimmed" size="sm">
						{t("noSourceChapters")}
					</Text>
				)}

				<TextInput
					label={t("mergeSessionTitle")}
					placeholder={t("mergeSessionPlaceholder")}
					value={title}
					onChange={(e) => setTitle(e.currentTarget.value)}
					required
				/>

				<Select
					label={tc("strategy")}
					data={[
						{ value: "merge", label: t("strategyMerge") },
						{ value: "squash", label: t("strategySquash") },
						{ value: "cherry-pick", label: t("strategyCherryPick") },
					]}
					value={strategy}
					onChange={(v) => setStrategy(v ?? "merge")}
				/>

				{batchMerge.isError && (
					<Alert color="red" title={t("batchMergeFailed")}>
						<Text size="sm">
							{batchMerge.error instanceof Error ? batchMerge.error.message : tc("unknownError")}
						</Text>
					</Alert>
				)}
				<Button
					color="green"
					onClick={() => batchMerge.mutate()}
					loading={batchMerge.isPending}
					disabled={!baseChapterId || selected.length === 0 || !title.trim()}
				>
					{t("mergeCount", { count: selected.length })}
				</Button>
			</Stack>
		</Modal>
	);
}
