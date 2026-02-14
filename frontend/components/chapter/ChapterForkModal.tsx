import { Alert, Button, Modal, Select, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

interface ChapterForkModalProps {
	chapterId: string;
	opened: boolean;
	onClose: () => void;
	forkAtMessageUuid?: string;
}

export function ChapterForkModal({
	chapterId,
	opened,
	onClose,
	forkAtMessageUuid,
}: ChapterForkModalProps) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [inheritMode, setInheritMode] = useState<string>("fresh");
	const qc = useQueryClient();
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");

	// When forking from a specific message, default to full inheritance
	useEffect(() => {
		if (forkAtMessageUuid) {
			setInheritMode("full");
		}
	}, [forkAtMessageUuid]);

	const resetState = () => {
		setTitle("");
		setDescription("");
		setInheritMode("fresh");
	};

	const handleClose = () => {
		resetState();
		onClose();
	};

	const fork = useMutation({
		mutationFn: () =>
			api.forkChapter(chapterId, {
				title: title.trim(),
				description: description.trim() || undefined,
				inheritMode,
				forkAtMessageUuid,
			}),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["graph"] });
			handleClose();
		},
	});

	return (
		<Modal opened={opened} onClose={handleClose} title={t("forkChapter")}>
			<Stack>
				{forkAtMessageUuid && (
					<Alert color="blue" variant="light">
						{t("forkAtMessageAlert")}
					</Alert>
				)}
				<TextInput
					label={tc("title")}
					placeholder={t("forkTitlePlaceholder")}
					value={title}
					onChange={(e) => setTitle(e.currentTarget.value)}
					required
				/>
				<Textarea
					label={tc("description")}
					placeholder={t("forkDescriptionPlaceholder")}
					value={description}
					onChange={(e) => setDescription(e.currentTarget.value)}
				/>
				<Select
					label={t("contextInheritance")}
					data={[
						{ value: "fresh", label: t("inheritFresh") },
						{ value: "compressed", label: t("inheritCompressed") },
						{ value: "full", label: t("inheritFull") },
					]}
					value={inheritMode}
					onChange={(v) => setInheritMode(v ?? "fresh")}
				/>
				{fork.isError && (
					<Alert color="red" title={t("forkFailed")}>
						<Text size="sm">
							{fork.error instanceof Error ? fork.error.message : tc("unknownError")}
						</Text>
					</Alert>
				)}
				<Button onClick={() => fork.mutate()} loading={fork.isPending} disabled={!title.trim()}>
					{t("fork")}
				</Button>
			</Stack>
		</Modal>
	);
}
