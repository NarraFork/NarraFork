import {
	Alert,
	Badge,
	Button,
	Group,
	SegmentedControl,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useResolveKnowledgeConflict,
	useReviewKnowledgeSubmission,
} from "../../hooks/useKnowledge";
import type {
	FindingSeverity,
	KnowledgeFinding,
	KnowledgeSubmissionDetail,
	KnowledgeVerdict,
} from "../../lib/api";
import { DiffView } from "../narrator/DiffView";

interface Props {
	submission: KnowledgeSubmissionDetail;
	/** Current main content, used as the "old" side of the diff. */
	currentContent: string;
	canReview: boolean;
	onDone?: () => void;
}

const SEVERITIES: FindingSeverity[] = ["critical", "major", "minor", "suggestion"];

export function SubmissionReviewPanel({ submission, currentContent, canReview, onDone }: Props) {
	const { t } = useTranslation("knowledge");
	const reviewMut = useReviewKnowledgeSubmission();
	const resolveMut = useResolveKnowledgeConflict();

	const [verdict, setVerdict] = useState<KnowledgeVerdict>("approve");
	const [findings, setFindings] = useState<(KnowledgeFinding & { key: string })[]>([]);
	const [resolved, setResolved] = useState<string>(submission.proposedContent);

	const isConflict = submission.status === "conflict";
	const isPending = submission.status === "pending";

	const addFinding = () =>
		setFindings((f) => [...f, { key: crypto.randomUUID(), severity: "minor", message: "" }]);
	const updateFinding = (key: string, patch: Partial<KnowledgeFinding>) =>
		setFindings((f) => f.map((x) => (x.key === key ? { ...x, ...patch } : x)));
	const removeFinding = (key: string) => setFindings((f) => f.filter((x) => x.key !== key));

	const submitReview = () => {
		reviewMut.mutate(
			{
				id: submission.id,
				verdict,
				findings: findings.filter((f) => f.message.trim()).map(({ key: _key, ...rest }) => rest),
			},
			{ onSuccess: onDone },
		);
	};

	const submitResolve = () => {
		resolveMut.mutate({ id: submission.id, resolvedContent: resolved }, { onSuccess: onDone });
	};

	return (
		<Stack>
			<Group justify="space-between">
				<Group gap="xs">
					<Text size="sm" fw={600}>
						{t("submission")}
					</Text>
					<Badge size="sm" variant="light" color={isConflict ? "orange" : "blue"}>
						{t(`submissionStatus_${submission.status}`)}
					</Badge>
				</Group>
				{submission.changeNote ? (
					<Text size="xs" c="dimmed">
						{submission.changeNote}
					</Text>
				) : null}
			</Group>

			{/* Proposed vs current diff */}
			<div>
				<Text size="xs" c="dimmed" mb={4}>
					{t("proposedVsMain")}
				</Text>
				<DiffView
					oldStr={currentContent}
					newStr={submission.proposedContent}
					language="markdown"
					maxHeight={360}
					wordWrap
				/>
			</div>

			{isConflict ? (
				<Stack gap="sm">
					<Alert color="orange" title={t("conflict")}>
						{t("conflictDesc")}
					</Alert>
					<Textarea
						label={t("resolvedContent")}
						value={resolved}
						onChange={(e) => setResolved(e.currentTarget.value)}
						autosize
						minRows={6}
						maxRows={20}
					/>
					{canReview ? (
						<Group justify="flex-end">
							<Button
								onClick={submitResolve}
								loading={resolveMut.isPending}
								disabled={!resolved.trim()}
							>
								{t("resolveAndMerge")}
							</Button>
						</Group>
					) : null}
				</Stack>
			) : isPending && canReview ? (
				<Stack gap="sm">
					<div>
						<Text size="xs" c="dimmed" mb={4}>
							{t("verdict")}
						</Text>
						<SegmentedControl
							value={verdict}
							onChange={(v) => setVerdict(v as KnowledgeVerdict)}
							data={[
								{ value: "approve", label: t("approve") },
								{ value: "request_changes", label: t("requestChanges") },
								{ value: "comment_only", label: t("commentOnly") },
							]}
						/>
					</div>

					{/* Findings */}
					<Stack gap="xs">
						<Group justify="space-between">
							<Text size="xs" c="dimmed">
								{t("findings")}
							</Text>
							<Button
								size="compact-xs"
								variant="light"
								leftSection={<IconPlus size={12} />}
								onClick={addFinding}
							>
								{t("addFinding")}
							</Button>
						</Group>
						{findings.map((f) => (
							<Group key={f.key} gap="xs" wrap="nowrap" align="flex-start">
								<Select
									size="xs"
									w={120}
									value={f.severity}
									onChange={(v) => v && updateFinding(f.key, { severity: v as FindingSeverity })}
									data={SEVERITIES.map((s) => ({ value: s, label: t(`severity_${s}`) }))}
								/>
								<TextInput
									size="xs"
									style={{ flex: 1 }}
									placeholder={t("findingMessage")}
									value={f.message}
									onChange={(e) => updateFinding(f.key, { message: e.currentTarget.value })}
								/>
								<Button
									size="compact-xs"
									variant="subtle"
									color="red"
									onClick={() => removeFinding(f.key)}
								>
									<IconTrash size={12} />
								</Button>
							</Group>
						))}
					</Stack>

					<Group justify="flex-end">
						<Button onClick={submitReview} loading={reviewMut.isPending}>
							{t("verdict")}
						</Button>
					</Group>
				</Stack>
			) : (
				<Text size="xs" c="dimmed">
					{submission.verdict ? t(`submissionStatus_${submission.status}`) : null}
				</Text>
			)}
		</Stack>
	);
}
