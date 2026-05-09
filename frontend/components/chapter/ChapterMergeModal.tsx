import { Alert, Button, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../../lib/api";

interface MergeCheckResult {
	hasConflicts: boolean;
	conflictFiles: string[];
	isFastForward: boolean;
}

const MERGE_MODAL_QUERY_GC_TIME_MS = 60_000;

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
	const [conflicts, setConflicts] = useState<MergeCheckResult | null>(null);
	const qc = useQueryClient();
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");

	// Query project settings to check if review is required before merge
	const { data: project } = useQuery({
		queryKey: ["project", projectId],
		queryFn: () => api.getProject(projectId),
		enabled: opened,
		gcTime: MERGE_MODAL_QUERY_GC_TIME_MS,
	});

	const cs = project?.chapterSettings as Record<string, unknown> | null;
	const requireReview = !!cs?.requireReviewBeforeMerge;

	// Query latest review conclusion for the source chapter
	const { data: reviewData } = useQuery({
		queryKey: ["reviewConclusion", "source", chapterId],
		queryFn: () => api.getReviewConclusionForSource(chapterId),
		enabled: opened && requireReview,
		gcTime: MERGE_MODAL_QUERY_GC_TIME_MS,
	});

	const reviewVerdict = reviewData?.conclusion?.verdict ?? null;
	const reviewBlocked = requireReview && reviewVerdict !== "approve";

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
		gcTime: MERGE_MODAL_QUERY_GC_TIME_MS,
	});

	const targetOptions = (chapters ?? [])
		.filter((ch) => ch.id !== chapterId && ch.status === "active")
		.map((ch) => ({ value: ch.id, label: ch.title }));

	const checkConflicts = useMutation({
		mutationFn: () =>
			api.checkMergeConflicts(chapterId, targetId ?? "") as Promise<MergeCheckResult>,
		onSuccess: (data) => setConflicts(data),
	});

	const merge = useMutation({
		mutationFn: () =>
			api.mergeChapter(chapterId, {
				targetChapterId: targetId ?? "",
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

				{conflicts?.hasConflicts && (
					<Alert color="yellow" title={t("conflictsDetected")}>
						<Text size="sm">
							{t("conflictsDescription", { count: conflicts.conflictFiles?.length ?? 0 })}
						</Text>
					</Alert>
				)}

				{conflicts && !conflicts.hasConflicts && (
					<Alert
						color="green"
						title={conflicts.isFastForward ? t("fastForward") : t("noConflicts")}
					>
						<Text size="sm">
							{conflicts.isFastForward ? t("fastForwardDescription") : t("mergeClean")}
						</Text>
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
							{merge.error instanceof ApiError && merge.error.data?.error === "MERGE_DIRTY_SOURCE"
								? t("mergeDirtySource")
								: merge.error instanceof ApiError &&
										merge.error.data?.error === "MERGE_DIRTY_TARGET"
									? t("mergeDirtyTarget")
									: merge.error instanceof Error
										? merge.error.message
										: tc("unknownError")}
						</Text>
					</Alert>
				)}

				{reviewBlocked && (
					<Alert
						color={reviewVerdict === "request_changes" ? "red" : "orange"}
						title={
							reviewVerdict === "request_changes"
								? t("mergeReviewRequestChanges")
								: t("mergeReviewRequired")
						}
					>
						<Text size="sm">
							{reviewVerdict === "request_changes"
								? t("mergeReviewRequestChangesDesc")
								: t("mergeReviewRequiredDesc")}
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
				<Button
					onClick={() => merge.mutate()}
					loading={merge.isPending}
					disabled={!targetId || reviewBlocked}
				>
					{t("merge")}
				</Button>
			</Stack>
		</Modal>
	);
}
