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
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChapterSplitCapability } from "../../hooks/usePlatform";
import { api } from "../../lib/api";

type SplitInheritMode = "fresh" | "compressed" | "full";

interface ChapterSplitModalProps {
	chapterId: string;
	commitSha: string | null;
	commitMessage?: string | null;
	opened: boolean;
	onClose: () => void;
}

const MAX_SPLIT_TITLE_CHARS = 200;
const MAX_SPLIT_DESCRIPTION_CHARS = 2000;
const MAX_SPLIT_MESSAGE_PREVIEW_CHARS = 120;

function firstLine(value: string | null | undefined): string {
	return (value ?? "").split("\n")[0]?.trim() ?? "";
}

function truncate(value: string, maxChars: number): string {
	return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

export function ChapterSplitModal({
	chapterId,
	commitSha,
	commitMessage,
	opened,
	onClose,
}: ChapterSplitModalProps) {
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");
	const queryClient = useQueryClient();
	const chapterSplitCapability = useChapterSplitCapability();
	const splitUnsupportedReason = chapterSplitCapability.supported
		? undefined
		: (chapterSplitCapability.reason ?? t("splitUnsupported"));
	const commitShortSha = commitSha?.slice(0, 8) ?? "";
	const messagePreview = useMemo(
		() => truncate(firstLine(commitMessage), MAX_SPLIT_MESSAGE_PREVIEW_CHARS),
		[commitMessage],
	);
	const defaultTitle = useMemo(
		() =>
			t("splitDefaultTitle", {
				sha: commitShortSha,
				message: messagePreview,
			}),
		[t, commitShortSha, messagePreview],
	);
	const [title, setTitle] = useState(defaultTitle);
	const [description, setDescription] = useState("");
	const [inheritMode, setInheritMode] = useState<SplitInheritMode>("fresh");

	useEffect(() => {
		if (!opened) return;
		setTitle(defaultTitle);
		setDescription("");
		setInheritMode("fresh");
	}, [opened, defaultTitle]);

	const splitMutation = useMutation({
		mutationFn: () => {
			if (!commitSha) throw new Error(t("splitMissingCommit"));
			if (!chapterSplitCapability.supported) {
				throw new Error(splitUnsupportedReason ?? t("splitUnsupported"));
			}
			return api.splitChapter(chapterId, {
				commitSha,
				newFork: {
					title: title.trim(),
					description: description.trim() || undefined,
					inheritMode,
				},
			});
		},
		onSuccess: (result) => {
			void queryClient.invalidateQueries({ queryKey: ["chapters"] });
			void queryClient.invalidateQueries({ queryKey: ["graph"] });
			void queryClient.invalidateQueries({ queryKey: ["narraFlow"] });
			void queryClient.invalidateQueries({ queryKey: ["chapterCommits"] });
			void queryClient.invalidateQueries({ queryKey: ["gitLog"] });
			void queryClient.invalidateQueries({ queryKey: ["ruler"] });
			void queryClient.invalidateQueries({ queryKey: ["rulerSegment"] });
			void queryClient.invalidateQueries({ queryKey: ["commitDetail", chapterId] });

			notifications.show({
				title: t("splitSuccessTitle"),
				message: t("splitSuccess", {
					title: result.newForkChapter?.title ?? title.trim(),
				}),
				color: "green",
			});

			const warningCount = result.warnings?.length ?? 0;
			const fallbackCount = result.fallbacks?.length ?? 0;
			if (warningCount > 0 || fallbackCount > 0) {
				notifications.show({
					title: t("splitWarningTitle"),
					message: t("splitWarningSummary", {
						warnings: warningCount,
						fallbacks: fallbackCount,
					}),
					color: "yellow",
					autoClose: 10_000,
				});
			}

			onClose();
		},
		onError: (err) => {
			notifications.show({
				title: t("splitFailedTitle"),
				message: err instanceof Error ? err.message : String(err),
				color: "red",
			});
		},
	});

	const compressedSummaryFallback =
		inheritMode === "compressed" &&
		(chapterSplitCapability.compressedAISummaryFallback ||
			!chapterSplitCapability.compressedAISummarySupported);
	const canSubmit = !!commitSha && title.trim().length > 0 && !splitUnsupportedReason;

	return (
		<Modal opened={opened} onClose={onClose} title={t("splitChapterTitle")} centered>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					{t("splitChapterDesc")}
				</Text>
				{commitSha && (
					<Text size="xs" c="dimmed" ff="monospace">
						{commitShortSha}
						{messagePreview ? ` · ${messagePreview}` : ""}
					</Text>
				)}

				{splitUnsupportedReason && (
					<Alert color="yellow" variant="light" title={t("splitUnsupportedTitle")}>
						{splitUnsupportedReason}
					</Alert>
				)}

				<TextInput
					label={t("splitNewForkTitle")}
					placeholder={t("forkTitlePlaceholder")}
					value={title}
					onChange={(event) => setTitle(event.currentTarget.value)}
					maxLength={MAX_SPLIT_TITLE_CHARS}
					required
				/>
				<Textarea
					label={t("splitNewForkDescription")}
					placeholder={t("forkDescriptionPlaceholder")}
					value={description}
					onChange={(event) => setDescription(event.currentTarget.value)}
					maxLength={MAX_SPLIT_DESCRIPTION_CHARS}
					autosize
					minRows={2}
					maxRows={5}
				/>
				<Select
					label={t("contextInheritance")}
					value={inheritMode}
					onChange={(value) => setInheritMode((value as SplitInheritMode | null) ?? "fresh")}
					data={[
						{ value: "fresh", label: t("inheritFresh") },
						{ value: "compressed", label: t("inheritCompressed") },
						{ value: "full", label: t("inheritFull") },
					]}
					allowDeselect={false}
				/>
				{compressedSummaryFallback && (
					<Alert color="yellow" variant="light" title={t("splitCompressedFallbackTitle")}>
						{chapterSplitCapability.compressedAISummaryReason ??
							t("splitCompressedFallbackDesc", {
								mode:
									chapterSplitCapability.compressedAISummaryMode ??
									t("splitCompressedFallbackMode"),
							})}
					</Alert>
				)}

				<Group justify="flex-end">
					<Button variant="subtle" onClick={onClose}>
						{tc("cancel")}
					</Button>
					<Button
						onClick={() => splitMutation.mutate()}
						disabled={!canSubmit}
						loading={splitMutation.isPending}
					>
						{t("splitConfirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
