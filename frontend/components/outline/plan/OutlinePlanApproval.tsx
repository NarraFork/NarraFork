/**
 * The approval of an outline session's plan (outline P2 PR 8, D48 Q5), in place of the plan-file
 * approval form: a one-line summary of what changed since the previous version, the feedback box,
 * and the three choices (return, execute as draft, lock and execute), with "view changes" (the
 * block-by-block diff) and "open in outline" (the plan, editable, in the outline beside the
 * session). The plan's text itself is the tool card's, as before.
 *
 * Decisions go to `POST /narrators/permissions/:id/plan`, which writes the outline before it
 * resolves the request: a plan someone else changed since the version on screen is refused (409)
 * and the diff opens again; the request disappears through the usual `permission_resolved`.
 *
 * A plan review's comments (PR 8b, `_planReview`) lead the summary line (「审查意见 N 条」, in
 * the same line: the card's height is unchanged) and the diff, which leaves them out of the
 * changes and shows them above.
 */

import {
	Alert,
	Anchor,
	Box,
	Button,
	Checkbox,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { outlinePlanSubmissionOf } from "@shared/outline-plan-submission";
import { useQuery } from "@tanstack/react-query";
import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarrator } from "../../../hooks/useNarrator";
import { useOutlinePlanDiff } from "../../../hooks/useOutline";
import { ApiError, api } from "../../../lib/api";
import { outlineTargetHref } from "../../../lib/outline-href";
import { useOutlineOpener } from "../../../lib/outline-opener";
import type { PendingPermission } from "../../../types/narrator";
import { MESSAGE_SELECTION_IGNORE_ATTR } from "../../narrator/message/MessageSelectionCtx";
import { type PermButton, PermButtonBar } from "../../narrator/permission/PermButtonBar";
import { PermEnterHintCtx } from "../../narrator/tool-call/tool-call-contexts";
import { OutlinePlanDiffModal } from "./OutlinePlanDiffModal";

const noop = () => {};

/** Whether a pending request is an outline plan's approval (rendered by this component). */
export function isOutlinePlanApproval(permission: PendingPermission): boolean {
	return (
		permission.toolName === "ExitPlanMode" &&
		outlinePlanSubmissionOf(permission.inputJson as Record<string, unknown> | undefined) !== null
	);
}

/** Sessions that may confirm step changes for the person: the project's, not this one. */
function useDelegateOptions(narratorId: string, enabled: boolean) {
	const narrator = useNarrator(enabled ? narratorId : "");
	const projectId = (narrator.data as { projectId?: string | null } | undefined)?.projectId ?? null;
	const query = useQuery({
		queryKey: ["outline", "lock-delegates", projectId],
		queryFn: () => api.listNarratorsPaginated({ projectId: projectId as string, limit: 30 }),
		enabled: enabled && projectId !== null,
		staleTime: 30_000,
	});
	return (query.data?.items ?? [])
		.filter((n: { id: string; type?: string }) => n.type !== "subagent" && n.id !== narratorId)
		.map((n: { id: string; title?: string | null }) => ({ value: n.id, label: n.title || n.id }));
}

export function OutlinePlanApproval({
	permission,
	readOnly,
}: {
	permission: PendingPermission;
	readOnly: boolean;
}) {
	const { t } = useTranslation("narrator");
	const submission = useMemo(
		() => outlinePlanSubmissionOf(permission.inputJson as Record<string, unknown> | undefined),
		[permission.inputJson],
	);
	const { focusIndex, setButtonCount, setHasFeedback, registerActions, activePermissionId } =
		useContext(PermEnterHintCtx);
	const isActive = permission.id === activePermissionId;
	const [feedback, setFeedback] = useState("");
	const [diffOpen, setDiffOpen] = useState(false);
	const [lockOpen, setLockOpen] = useState(false);
	const [delegate, setDelegate] = useState<string | null>(null);
	// "Reset the context" is chosen in a dialog and goes with that dialog's decision only
	// (review round 1 N10): closing either dialog forgets it.
	const [compact, setCompact] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const opener = useOutlineOpener();
	const narratorId = permission.ownerNarratorId ?? "";
	const delegates = useDelegateOptions(narratorId, lockOpen && !readOnly);
	const root = submission?.root;
	const review = submission?.review ?? null;
	const diff = useOutlinePlanDiff(
		{
			spaceId: root?.spaceId ?? "",
			pageId: root?.pageId ?? "",
			blockId: root?.blockId ?? "",
			from: submission?.baseSeq ?? 0,
			skip: review?.blockId ?? null,
		},
		diffOpen && !!root,
	);
	// Typed feedback makes Enter return the plan, as on every other permission card (review
	// round 1 S5): the focus moves to the last decision, which is "Return".
	const hasFeedback = feedback.trim().length > 0;
	useEffect(() => {
		if (isActive) setHasFeedback(hasFeedback);
	}, [hasFeedback, isActive, setHasFeedback]);
	if (!submission || !root) return null;
	const counts = submission.counts;
	const changed = counts.text + counts.task + counts.moved;
	// The version on screen: the diff's when it was read, else the version submitted.
	const seenSeq = diff.data?.toSeq ?? submission.seq;

	const closeDiff = () => {
		setDiffOpen(false);
		setCompact(false);
	};
	const closeLock = () => {
		setLockOpen(false);
		setCompact(false);
	};

	const decide = async (action: "return" | "draft" | "lock", withCompact = false) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await api.decideOutlinePlan(permission.id, {
				action,
				...(feedback.trim() ? { feedback: feedback.trim() } : {}),
				...(action === "lock" ? { delegate } : {}),
				seenSeq,
				...(action !== "return" && withCompact ? { compactAfter: true } : {}),
			});
			closeLock();
			closeDiff();
		} catch (err) {
			if (
				err instanceof ApiError &&
				err.status === 409 &&
				err.data?.code === "OUTLINE_PLAN_CHANGED"
			) {
				setError(t("outlinePlan.changed"));
				closeLock();
				setDiffOpen(true);
				void diff.refetch();
			} else {
				setError(`${t("outlinePlan.failed")}: ${err instanceof Error ? err.message : String(err)}`);
			}
		} finally {
			setBusy(false);
		}
	};

	const openBlock = (blockId: string) => {
		const target = { spaceId: root.spaceId, blockId, pageId: root.pageId };
		if (opener?.open(target, { newPanel: false })) return;
		window.open(outlineTargetHref({ kind: "block", spaceId: root.spaceId, blockId }), "_blank");
	};
	const openInOutline = () => openBlock(root.blockId);
	const reviewCount = review?.count ?? 0;

	// The three decisions only, "Return" last: the keyboard's default with feedback typed.
	const buttons: PermButton[] = readOnly
		? []
		: [
				{ label: t("outlinePlan.draft"), color: "green", onClick: () => void decide("draft") },
				{
					label: t("outlinePlan.lock"),
					color: "indigo",
					variant: "light",
					onClick: () => setLockOpen(true),
				},
				{
					label: t("outlinePlan.return"),
					color: "red",
					variant: "light",
					onClick: () => void decide("return"),
				},
			];

	const decisionButtons = (
		<Group gap="xs" justify="flex-end">
			<Button
				size="xs"
				color="red"
				variant="light"
				loading={busy}
				onClick={() => void decide("return")}
				data-testid="outline-plan-return-modal"
			>
				{t("outlinePlan.return")}
			</Button>
			<Button
				size="xs"
				color="indigo"
				variant="light"
				onClick={() => {
					setDiffOpen(false);
					setLockOpen(true);
				}}
			>
				{t("outlinePlan.lock")}
			</Button>
			<Button
				size="xs"
				color="green"
				loading={busy}
				onClick={() => void decide("draft", compact)}
				data-testid="outline-plan-draft-modal"
			>
				{t("outlinePlan.draft")}
			</Button>
		</Group>
	);

	return (
		<Box mt="xs" {...{ [MESSAGE_SELECTION_IGNORE_ATTR]: "" }} data-testid="outline-plan-approval">
			{/* One xs line: the summary (cut to fit) and the two read-only views, for readers too. */}
			<Group gap={8} mb={4} wrap="nowrap" align="baseline">
				<Text
					size="xs"
					c="dimmed"
					truncate="end"
					style={{ flex: 1, minWidth: 0 }}
					data-testid="outline-plan-summary"
				>
					{reviewCount > 0 && (
						<>
							<Text span inherit c="orange" fw={600} data-testid="outline-plan-review-count">
								{t("outlinePlan.reviewCount", { count: reviewCount })}
							</Text>
							{" · "}
						</>
					)}
					{submission.baseSeq === 0
						? t("outlinePlan.summaryFirst", { version: root.round, added: counts.added })
						: t("outlinePlan.summary", {
								version: root.round,
								added: counts.added,
								changed,
								removed: counts.removed,
							})}
				</Text>
				<Anchor
					component="button"
					type="button"
					size="xs"
					onClick={() => setDiffOpen(true)}
					style={{ flexShrink: 0 }}
					data-testid="outline-plan-view-changes"
				>
					{t("outlinePlan.viewChanges")}
				</Anchor>
				<Anchor
					component="button"
					type="button"
					size="xs"
					onClick={openInOutline}
					style={{ flexShrink: 0 }}
					data-testid="outline-plan-open"
				>
					{t("outlinePlan.openInOutline")}
				</Anchor>
			</Group>
			{submission.summary && (
				<Text size="xs" mb={4} truncate="end" data-testid="outline-plan-agent-summary">
					{t("outlinePlan.agentSummary", { summary: submission.summary })}
				</Text>
			)}
			{error && (
				<Alert color="orange" variant="light" p={6} mb={4} data-testid="outline-plan-error">
					<Text size="xs">{error}</Text>
				</Alert>
			)}
			<Textarea
				size="xs"
				placeholder={t("outlinePlan.feedbackPlaceholder")}
				value={feedback}
				onChange={(e) => setFeedback(e.currentTarget.value)}
				autosize
				minRows={1}
				maxRows={3}
				mb="xs"
				disabled={readOnly}
				data-testid="outline-plan-feedback"
			/>
			{readOnly ? (
				<Text size="xs" c="dimmed">
					{t("permissionActionsUnavailable")}
				</Text>
			) : (
				<PermButtonBar
					focusIndex={isActive ? focusIndex : null}
					buttons={buttons}
					setButtonCount={isActive ? setButtonCount : noop}
					registerActions={isActive ? registerActions : noop}
				/>
			)}
			<OutlinePlanDiffModal
				opened={diffOpen}
				onClose={closeDiff}
				title={root.title}
				diff={diff.data}
				loading={diff.isLoading}
				error={diff.error}
				review={review}
				onOpenReview={review ? () => openBlock(review.blockId) : undefined}
				footer={
					<Stack gap="xs">
						{error && (
							<Text size="xs" c="orange">
								{error}
							</Text>
						)}
						{!readOnly && (
							<Checkbox
								size="xs"
								label={t("outlinePlan.compact")}
								checked={compact}
								onChange={(e) => setCompact(e.currentTarget.checked)}
							/>
						)}
						<Group justify="space-between" wrap="wrap">
							<Button size="xs" variant="subtle" color="gray" onClick={openInOutline}>
								{t("outlinePlan.openInOutline")}
							</Button>
							{readOnly ? null : decisionButtons}
						</Group>
					</Stack>
				}
			/>
			<Modal
				opened={lockOpen}
				onClose={closeLock}
				title={t("outlinePlan.lockTitle")}
				centered
				size="sm"
			>
				<Stack gap="sm" data-testid="outline-plan-lock-modal">
					<Text size="sm">{t("outlinePlan.lockExplain")}</Text>
					<Select
						size="xs"
						label={t("outlinePlan.delegateLabel")}
						placeholder={t("outlinePlan.delegatePlaceholder")}
						data={delegates}
						value={delegate}
						onChange={setDelegate}
						clearable
						searchable
						comboboxProps={{ withinPortal: true }}
						data-testid="outline-plan-delegate"
					/>
					<Checkbox
						size="xs"
						label={t("outlinePlan.compact")}
						checked={compact}
						onChange={(e) => setCompact(e.currentTarget.checked)}
					/>
					<Group justify="flex-end" gap="sm">
						<Button variant="subtle" color="gray" onClick={closeLock}>
							{t("outlinePlan.cancel")}
						</Button>
						<Button
							color="indigo"
							loading={busy}
							onClick={() => void decide("lock", compact)}
							data-testid="outline-plan-lock-confirm"
						>
							{t("outlinePlan.confirmLock")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Box>
	);
}
