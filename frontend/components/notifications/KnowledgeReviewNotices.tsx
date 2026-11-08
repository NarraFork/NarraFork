/**
 * Knowledge review rows inside the notification bell.
 *
 * These are not `notifications` table rows. Review events stay out of that table so a
 * classified entry title is never stored there. Reviewers see the ACL-checked inbox;
 * authors see their own recent verdicts (`/my-submission-outcomes`, ids and findings
 * only). A `knowledge:review_inbox_changed` push invalidates both queries.
 */
import { Stack, Text, UnstyledButton } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
	useKnowledgeSubmissions,
	useMarkSubmissionOutcomesRead,
	useMyKnowledgeSubmissionOutcomes,
	useReviewInboxCount,
} from "../../hooks/useKnowledge";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { knowledgeRequestDestination } from "../../lib/knowledge-review-nav";

const REVIEWER_ROW_CAP = 5;

export function KnowledgeReviewNotices({ onOpen }: { onOpen: () => void }) {
	const { t } = useTranslation("knowledge");
	const navigate = useNavigate();
	const inbox = useReviewInboxCount();
	const outcomes = useMyKnowledgeSubmissionOutcomes();
	const markOutcomeRead = useMarkSubmissionOutcomesRead();
	const pending = useKnowledgeSubmissions({ status: "pending" });
	const conflicts = useKnowledgeSubmissions({ status: "conflict" });

	const reviewerRows = [...(pending.data ?? []), ...(conflicts.data ?? [])].slice(
		0,
		REVIEWER_ROW_CAP,
	);
	const authorRows = outcomes.data ?? [];
	const inboxCount = inbox.data?.count ?? 0;
	if (inboxCount === 0 && reviewerRows.length === 0 && authorRows.length === 0) return null;

	// Every row — reviewer inbox or author verdict, linked or standalone — opens the request
	// page, which re-checks access and shows the actions this viewer has.
	const openRequest = (submissionId: string) => {
		void navigate(knowledgeRequestDestination(submissionId));
		onOpen();
	};

	/**
	 * Opening a verdict is what marks it read — the same "activation is acknowledgement"
	 * rule the notification center uses for its own rows. Fire-and-forget: navigation
	 * unmounts this panel, and a failed stamp must not block the jump.
	 */
	const openOutcome = (submissionId: string, unread: boolean) => {
		if (unread) void markOutcomeRead.mutateAsync([submissionId]).catch(() => {});
		openRequest(submissionId);
	};

	const inboxLabel = inbox.data?.capped
		? t("reviewNoticeInboxCapped", { count: inboxCount })
		: t("reviewNoticeInbox", { count: inboxCount });

	return (
		<Stack gap={4} data-testid="knowledge-review-notices">
			<Text size="xs" fw={600} c="dimmed">
				{t("reviewNoticeSection")}
			</Text>
			{inboxCount > 0 ? (
				<UnstyledButton
					data-testid="knowledge-review-inbox"
					onClick={() => {
						void navigate({ to: "/knowledge/review" });
						onOpen();
					}}
					style={{ width: "100%", textAlign: "left", padding: "8px 12px", borderRadius: 8 }}
				>
					<Text size="sm" fw={600}>
						{inboxLabel}
					</Text>
					<Text size="xs" c="dimmed">
						{t("reviewNoticeOpenCenter")}
					</Text>
				</UnstyledButton>
			) : null}
			{reviewerRows.map((row) => (
				<UnstyledButton
					key={row.id}
					data-testid="knowledge-review-notice"
					data-submission-id={row.id}
					onClick={() => openRequest(row.id)}
					style={{ width: "100%", textAlign: "left", padding: "8px 12px", borderRadius: 8 }}
				>
					<Text size="sm" fw={600} lineClamp={1}>
						{t("reviewNoticeAwaiting")}
					</Text>
					<Text size="xs" c="dimmed">
						{t(`submissionStatus_${row.status}`)} · {formatLocaleDateTime(row.createdAt)}
					</Text>
				</UnstyledButton>
			))}
			{authorRows.map((row) => {
				const finding = row.findingsJson?.[0];
				const unread = !row.authorReadAt;
				return (
					<UnstyledButton
						key={row.id}
						data-testid="knowledge-review-outcome"
						data-submission-id={row.id}
						data-unread={unread ? "true" : undefined}
						onClick={() => openOutcome(row.id, unread)}
						style={{ width: "100%", textAlign: "left", padding: "8px 12px", borderRadius: 8 }}
					>
						<Text size="sm" fw={unread ? 700 : 600} lineClamp={1}>
							{t(`reviewNoticeOutcome_${row.status}`)}
						</Text>
						{finding ? (
							<Text size="xs" c="dimmed" lineClamp={2}>
								[{t(`severity_${finding.severity}`)}] {finding.message}
							</Text>
						) : (
							<Text size="xs" c="dimmed">
								{formatLocaleDateTime(row.reviewedAt ?? row.createdAt)}
							</Text>
						)}
					</UnstyledButton>
				);
			})}
		</Stack>
	);
}
