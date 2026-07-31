/**
 * Author-side actions on a publish request: withdraw and re-submit.
 *
 * These close the two open ends of the review state machine:
 *  - An open request (pending / conflict) could previously only be retracted by editing the
 *    draft and relying on auto-invalidation — a side effect used as a feature, and impossible
 *    for a `conflict` request (which is deliberately never auto-closed). → Withdraw.
 *  - A `changes_requested` request left the author to hand-create a submission that looked
 *    unrelated to the reviewer. → Re-submit, which links the rounds.
 *
 * Visibility is by status AND identity: only the submitter (or an admin) sees the buttons, and
 * only for the status each action accepts. The server enforces both independently — this
 * component just avoids showing a button that would be refused.
 *
 * Shared by the global entry's Submissions tab and the standalone personal-entry page, so both
 * surfaces behave identically.
 */
import { Alert, Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { IconAlertTriangle, IconArrowBackUp, IconSend } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useResubmitKnowledgeSubmission,
	useWithdrawKnowledgeSubmission,
} from "../../hooks/useKnowledge";
import type { KnowledgeSubmissionStatus } from "../../lib/api";

export interface SubmissionAuthorActionsProps {
	submissionId: string;
	status: KnowledgeSubmissionStatus;
	/** Submission owner, compared against the current user to decide visibility. */
	submitterUserId: string;
	currentUserId: string | undefined;
	isAdmin: boolean;
	/** Personal entry (draft) id, used only to scope cache invalidation. */
	personalEntryId?: string;
	/** Re-submit reads the draft's saved content, so unsaved edits must be flushed first. */
	onBeforeResubmit?: () => Promise<void> | void;
	size?: "compact-xs" | "xs";
}

/** Statuses the author may withdraw / re-submit — mirrors the service-side guards. */
const WITHDRAWABLE: KnowledgeSubmissionStatus[] = ["pending", "conflict"];

export function SubmissionAuthorActions({
	submissionId,
	status,
	submitterUserId,
	currentUserId,
	isAdmin,
	personalEntryId,
	onBeforeResubmit,
	size = "compact-xs",
}: SubmissionAuthorActionsProps) {
	const { t } = useTranslation("knowledge");
	const withdraw = useWithdrawKnowledgeSubmission();
	const resubmit = useResubmitKnowledgeSubmission();
	const [withdrawOpen, setWithdrawOpen] = useState(false);
	const [resubmitOpen, setResubmitOpen] = useState(false);
	const [reason, setReason] = useState("");
	const [note, setNote] = useState("");

	// The server allows an admin to act on someone else's submission; mirror that here so an
	// admin cleaning up isn't stuck with a read-only view.
	const isMine = !!currentUserId && submitterUserId === currentUserId;
	if (!isMine && !isAdmin) return null;

	const canWithdraw = WITHDRAWABLE.includes(status);
	const canResubmit = status === "changes_requested";
	if (!canWithdraw && !canResubmit) return null;

	const doResubmit = async () => {
		// Flush unsaved body edits first: the new submission is built from the SAVED draft.
		await onBeforeResubmit?.();
		resubmit.mutate(
			{ id: submissionId, changeNote: note.trim() || undefined, personalEntryId },
			{
				onSuccess: () => {
					setResubmitOpen(false);
					setNote("");
				},
			},
		);
	};

	return (
		<>
			<Group gap="xs">
				{canWithdraw ? (
					<Button
						size={size}
						variant="light"
						color="gray"
						leftSection={<IconArrowBackUp size={12} />}
						onClick={() => {
							setReason("");
							setWithdrawOpen(true);
						}}
					>
						{t("subFlowWithdraw")}
					</Button>
				) : null}
				{canResubmit ? (
					<Button
						size={size}
						variant="light"
						leftSection={<IconSend size={12} />}
						onClick={() => {
							setNote("");
							setResubmitOpen(true);
						}}
					>
						{t("subFlowResubmit")}
					</Button>
				) : null}
			</Group>

			<Modal
				opened={withdrawOpen}
				onClose={() => setWithdrawOpen(false)}
				title={t("subFlowWithdrawTitle")}
			>
				<Stack gap="md">
					<Text size="sm">{t("subFlowWithdrawDesc")}</Text>
					<Textarea
						label={t("subFlowWithdrawReason")}
						placeholder={t("subFlowWithdrawReasonPlaceholder")}
						value={reason}
						onChange={(e) => setReason(e.currentTarget.value)}
						autosize
						minRows={2}
						maxRows={5}
					/>
					{withdraw.isError ? (
						<Text size="xs" c="red">
							{(withdraw.error as Error).message}
						</Text>
					) : null}
					<Group justify="flex-end">
						<Button variant="subtle" size="xs" onClick={() => setWithdrawOpen(false)}>
							{t("cancel")}
						</Button>
						<Button
							size="xs"
							color="gray"
							loading={withdraw.isPending}
							onClick={() =>
								withdraw.mutate(
									{ id: submissionId, reason: reason.trim() || undefined, personalEntryId },
									{ onSuccess: () => setWithdrawOpen(false) },
								)
							}
						>
							{t("subFlowWithdraw")}
						</Button>
					</Group>
				</Stack>
			</Modal>

			<Modal
				opened={resubmitOpen}
				onClose={() => setResubmitOpen(false)}
				title={t("subFlowResubmitTitle")}
			>
				<Stack gap="md">
					<Alert color="blue" icon={<IconAlertTriangle size={16} />} p="xs">
						<Text size="xs">{t("subFlowResubmitDesc")}</Text>
					</Alert>
					<Textarea
						label={t("subFlowResubmitNote")}
						placeholder={t("subFlowResubmitNotePlaceholder")}
						value={note}
						onChange={(e) => setNote(e.currentTarget.value)}
						autosize
						minRows={2}
						maxRows={6}
					/>
					{resubmit.isError ? (
						<Text size="xs" c="red">
							{(resubmit.error as Error).message}
						</Text>
					) : null}
					<Group justify="flex-end">
						<Button variant="subtle" size="xs" onClick={() => setResubmitOpen(false)}>
							{t("cancel")}
						</Button>
						<Button size="xs" loading={resubmit.isPending} onClick={doResubmit}>
							{t("subFlowResubmit")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}
