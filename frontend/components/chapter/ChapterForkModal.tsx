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
import type { ForkWorktreeSource } from "@shared/chapter-fork";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { addRecentTab } from "../../hooks/useRecentTabs";
import { api } from "../../lib/api";
import {
	buildForkChapterRequest,
	type ForkInheritMode,
	getForkDefaults,
} from "../../lib/chapter-fork-options";
import { notifyResultWarnings } from "../../lib/operation-warnings";

interface ChapterForkModalProps {
	chapterId: string;
	opened: boolean;
	onClose: () => void;
	forkAtMessageUuid?: string;
	forkAtMessageId?: string;
	chapterStatus?: string | null;
	initialWorktreeSource?: ForkWorktreeSource;
	initialCommitSha?: string;
	initialInheritMode?: "fresh" | "compressed" | "full";
	/** If provided, called on successful fork instead of showing the navigation prompt */
	onForkSuccess?: (newChapterId: string) => void;
}

export function ChapterForkModal({
	chapterId,
	opened,
	onClose,
	forkAtMessageUuid,
	forkAtMessageId,
	chapterStatus,
	initialWorktreeSource,
	initialCommitSha,
	initialInheritMode,
	onForkSuccess,
}: ChapterForkModalProps) {
	const isMessageFork = !!(forkAtMessageUuid || forkAtMessageId);
	const isDormant = chapterStatus === "dormant";
	const defaults = getForkDefaults({
		isMessageFork,
		chapterStatus,
		initialWorktreeSource,
		initialInheritMode,
	});
	const defaultInheritMode = defaults.inheritMode;
	const defaultWorktreeSource = defaults.worktreeSource;
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [inheritMode, setInheritMode] = useState<string>(defaultInheritMode);
	const [worktreeSource, setWorktreeSource] = useState<ForkWorktreeSource>(defaultWorktreeSource);
	const [forkedChapter, setForkedChapter] = useState<{
		id: string;
		title: string;
	} | null>(null);
	const qc = useQueryClient();
	const navigate = useNavigate();
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");

	useEffect(() => {
		if (!opened) return;
		setInheritMode(defaultInheritMode);
		setWorktreeSource(defaultWorktreeSource);
	}, [opened, defaultInheritMode, defaultWorktreeSource]);

	const resetState = () => {
		setTitle("");
		setDescription("");
		setInheritMode(defaultInheritMode);
		setWorktreeSource(defaultWorktreeSource);
		setForkedChapter(null);
	};

	const handleClose = () => {
		resetState();
		onClose();
	};

	const fork = useMutation({
		mutationFn: () =>
			api.forkChapter(
				chapterId,
				buildForkChapterRequest({
					title,
					description,
					inheritMode: inheritMode as ForkInheritMode,
					worktreeSource,
					forkAtMessageUuid,
					forkAtMessageId,
					initialCommitSha,
				}),
			),
		onSuccess: async (data) => {
			qc.invalidateQueries({ queryKey: ["chapters"] });
			qc.invalidateQueries({ queryKey: ["graph"] });
			qc.invalidateQueries({ queryKey: ["narrators"] });
			qc.invalidateQueries({ queryKey: ["narraFlow"] });

			// Add the forked chapter to recent tabs immediately
			if (data?.id) {
				const narrators = await api.listNarrators({ chapterId: data.id });
				// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
				const primary = narrators?.find((n: any) => n.variant === "primary");
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

			// A time-travel fork may have been rebuilt from recorded file edits rather
			// than the parent's exact bytes; the warnings say so. Shared with the two
			// direct fork-from-message entry points so all three report it identically.
			notifyResultWarnings(t("forkWarning"), data);
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
			(n: any) => n.variant === "primary",
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
				{isMessageFork && (
					<Alert color="blue" variant="light">
						{t("forkAtMessageAlert")}
					</Alert>
				)}
				{isDormant && (
					<Alert color="yellow" variant="light">
						{t("sourceDormantCommitOnly")}
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
					label={t("fileSource")}
					data={[
						{
							value: "workspace",
							label: t(isMessageFork ? "sourceMessageWorkspace" : "sourceWorkspace"),
							disabled: isDormant,
						},
						{
							value: "commit",
							label: initialCommitSha
								? `${t("sourceSpecificCommit")} (${initialCommitSha.slice(0, 8)})`
								: t(isMessageFork ? "sourceMessageCommit" : "sourceLatestCommit"),
						},
					]}
					value={worktreeSource}
					onChange={(value) =>
						setWorktreeSource((value as ForkWorktreeSource | null) ?? defaultWorktreeSource)
					}
					allowDeselect={false}
				/>
				<Select
					label={t("conversationInheritance")}
					data={[
						{ value: "fresh", label: t("inheritFresh") },
						{ value: "compressed", label: t("inheritCompressed") },
						{ value: "full", label: t("inheritFull") },
					]}
					value={inheritMode}
					onChange={(v) => setInheritMode(v ?? defaultInheritMode)}
					allowDeselect={false}
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
