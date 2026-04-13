import {
	Alert,
	Button,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { addRecentTab } from "../../hooks/useRecentTabs";
import { api } from "../../lib/api";

interface ChapterForkModalProps {
	chapterId: string;
	opened: boolean;
	onClose: () => void;
	forkAtMessageUuid?: string;
	/** If provided, called on successful fork instead of showing the navigation prompt */
	onForkSuccess?: (newChapterId: string) => void;
}

export function ChapterForkModal({
	chapterId,
	opened,
	onClose,
	forkAtMessageUuid,
	onForkSuccess,
}: ChapterForkModalProps) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [inheritMode, setInheritMode] = useState<string>("fresh");
	const [forkedChapter, setForkedChapter] = useState<{
		id: string;
		title: string;
	} | null>(null);
	const qc = useQueryClient();
	const navigate = useNavigate();
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
		setForkedChapter(null);
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
		onSuccess: async (data) => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["graph"] });
			qc.invalidateQueries({ queryKey: ["narrators"] });
			qc.invalidateQueries({ queryKey: ["narraFlow"] });

			// Add the forked chapter to recent tabs immediately
			if (data?.id) {
				const narrators = await api.listNarrators({ chapterId: data.id });
				// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
				const primary = narrators?.find((n: any) => n.type === "primary");
				if (primary?.id) {
					addRecentTab({
						type: "chapter",
						id: data.id,
						narratorId: primary.id,
						title: data.title ?? title.trim(),
						subtitle: data.title,
						status: primary.status,
					});
				}
			}

			// Show warnings as toast notifications if any
			if (data?.warnings && Array.isArray(data.warnings)) {
				for (const warning of data.warnings) {
					notifications.show({
						color: "yellow",
						title: t("forkWarning"),
						message: String(warning),
						autoClose: 10_000,
					});
				}
			}
			if (onForkSuccess && data?.id) {
				handleClose();
				onForkSuccess(data.id);
			} else if (data?.id) {
				setForkedChapter({ id: data.id, title: data.title ?? title.trim() });
			} else {
				handleClose();
			}
		},
	});

	const goToForkedChapter = async () => {
		if (!forkedChapter) return;
		// Find the primary narrator of the new chapter
		const narrators = await api.listNarrators({ chapterId: forkedChapter.id });
		const primary = narrators?.find(
			// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
			(n: any) => n.type === "primary",
		);
		handleClose();
		if (primary?.id) {
			navigate({ to: "/narrators/$narratorId", params: { narratorId: primary.id } });
		} else {
			navigate({ to: "/chapters/$chapterId", params: { chapterId: forkedChapter.id } });
		}
	};

	// Success prompt: ask user whether to navigate to the new branch
	if (forkedChapter) {
		return (
			<Modal opened={opened} onClose={handleClose} title={t("forkSuccess")} centered>
				<Stack>
					<Text size="sm">{t("forkNavigatePrompt", { title: forkedChapter.title })}</Text>
					<Group justify="flex-end">
						<Button variant="default" onClick={handleClose}>
							{t("stayHere")}
						</Button>
						<Button onClick={goToForkedChapter}>{t("goToFork")}</Button>
					</Group>
				</Stack>
			</Modal>
		);
	}

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
