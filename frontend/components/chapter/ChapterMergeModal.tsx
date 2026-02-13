import { Alert, Button, Loader, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

interface ChapterMergeModalProps {
	chapterId: string;
	projectId: string;
	opened: boolean;
	onClose: () => void;
}

export function ChapterMergeModal({
	chapterId,
	projectId,
	opened,
	onClose,
}: ChapterMergeModalProps) {
	const [targetId, setTargetId] = useState<string | null>(null);
	const [strategy, setStrategy] = useState<string>("merge");
	const [message, setMessage] = useState("");
	const [conflicts, setConflicts] = useState<any>(null);
	const qc = useQueryClient();
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");

	const resetState = () => {
		setTargetId(null);
		setStrategy("merge");
		setMessage("");
		setConflicts(null);
	};

	const handleClose = () => {
		resetState();
		onClose();
	};

	// Get available target chapters (active chapters in the same project, excluding self)
	const { data: chapters } = useQuery({
		queryKey: ["chapters", { projectId }],
		queryFn: () => api.listChapters(projectId),
		enabled: opened,
	});

	const targetOptions = (chapters ?? [])
		.filter((ch: any) => ch.id !== chapterId && ch.status === "active")
		.map((ch: any) => ({ value: ch.id, label: ch.title }));

	const checkConflicts = useMutation({
		mutationFn: () => api.checkMergeConflicts(chapterId, targetId!),
		onSuccess: (data) => setConflicts(data),
	});

	const merge = useMutation({
		mutationFn: () =>
			api.mergeChapter(chapterId, {
				targetChapterId: targetId!,
				strategy,
				message: message.trim() || undefined,
			}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["graph"] });
			handleClose();
		},
	});

	const handleCheck = () => {
		if (targetId) checkConflicts.mutate();
	};

	return (
		<Modal opened={opened} onClose={handleClose} title={t("mergeChapter")}>
			<Stack>
				<Select
					label={t("mergeInto")}
					placeholder={t("selectTarget")}
					data={targetOptions}
					value={targetId}
					onChange={setTargetId}
					searchable
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
				<TextInput
					label={t("mergeMessage")}
					placeholder={t("mergeMessagePlaceholder")}
					value={message}
					onChange={(e) => setMessage(e.currentTarget.value)}
				/>

				{conflicts && conflicts.hasConflicts && (
					<Alert color="yellow" title={t("conflictsDetected")}>
						<Text size="sm">
							{t("conflictsDescription", { count: conflicts.conflictFiles?.length ?? 0 })}
						</Text>
					</Alert>
				)}

				{conflicts && !conflicts.hasConflicts && (
					<Alert color="green" title={t("noConflicts")}>
						<Text size="sm">{t("mergeClean")}</Text>
					</Alert>
				)}

				{checkConflicts.isError && (
					<Alert color="red" title={t("conflictCheckFailed")}>
						<Text size="sm">
							{checkConflicts.error instanceof Error
								? checkConflicts.error.message
								: tc("unknownError")}
						</Text>
					</Alert>
				)}

				{merge.isError && (
					<Alert color="red" title={t("mergeFailed")}>
						<Text size="sm">
							{merge.error instanceof Error ? merge.error.message : tc("unknownError")}
						</Text>
					</Alert>
				)}

				<Button
					variant="light"
					onClick={handleCheck}
					loading={checkConflicts.isPending}
					disabled={!targetId}
				>
					{t("checkConflicts")}
				</Button>
				<Button onClick={() => merge.mutate()} loading={merge.isPending} disabled={!targetId}>
					{t("merge")}
				</Button>
			</Stack>
		</Modal>
	);
}
