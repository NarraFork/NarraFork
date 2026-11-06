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
 * A plan review's comments (PR 8b, `_planReview`) lead the summary line as an orange count (its
 * full 「审查意见 N 条」 in the tooltip; the card's height is unchanged) and the diff, which leaves
 * them out of the changes and shows them above. On a narrow card (review round 1 U1) the two
 * views become icons and the counts their short form, so the version and its changes stay on
 * the one line.
 */

import {
	ActionIcon,
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
	Tooltip,
} from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { outlinePlanSubmissionOf } from "@shared/outline-plan-submission";
import { IconExternalLink, IconListDetails, IconMessageCircle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import {
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNarrator } from "../../../hooks/useNarrator";
import { useOutlinePlanDiff } from "../../../hooks/useOutline";
import { ApiError, api } from "../../../lib/api";
import { outlineTargetHref } from "../../../lib/outline-href";
import { useOutlineOpener } from "../../../lib/outline-opener";
import type { PendingPermission } from "../../../types/narrator";
import { MESSAGE_SELECTION_IGNORE_ATTR } from "../../narrator/message/MessageSelectionCtx";
import { type PermButton, PermButtonBar } from "../../narrator/permission/PermButtonBar";
import { usePermissionTextareaStyle } from "../../narrator/permission/permission-textarea-typography";
import { PermEnterHintCtx } from "../../narrator/tool-call/tool-call-contexts";
import { OutlinePlanDiffModal } from "./OutlinePlanDiffModal";

const noop = () => {};

/**
 * Below this width (in ems of the card's text, so it follows the reader's type size) the
 * summary line shows its short form and icon-only views: the full one no longer fits beside
 * them (review round 1 U1).
 */
const NARROW_SUMMARY_EM = 36;

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
	// In the transcript the feedback box paints the rows its height model counts (D49).
	const textareaStyle = usePermissionTextareaStyle();
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
		},
		diffOpen && !!root,
	);
	// Typed feedback makes Enter return the plan, as on every other permission card (review
	// round 1 S5): the focus moves to the last decision, which is "Return".
	const hasFeedback = feedback.trim().length > 0;
	useEffect(() => {
		if (isActive) setHasFeedback(hasFeedback);
	}, [hasFeedback, isActive, setHasFeedback]);
	// The summary line's width decides its form (the line stays one xs line either way).
	const { ref: sizeRef, width: summaryWidth } = useElementSize<HTMLDivElement>();
	const summaryNode = useRef<HTMLDivElement | null>(null);
	const summaryRef = useCallback(
		(node: HTMLDivElement | null) => {
			summaryNode.current = node;
			sizeRef(node);
		},
		[sizeRef],
	);
	const [narrow, setNarrow] = useState(
		() => typeof window !== "undefined" && window.innerWidth < 520,
	);
	useLayoutEffect(() => {
		const node = summaryNode.current;
		if (!node || summaryWidth <= 0) return;
		const em = Number.parseFloat(getComputedStyle(node).fontSize) || 14;
		setNarrow(summaryWidth < NARROW_SUMMARY_EM * em);
	}, [summaryWidth]);
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
	const fullSummary =
		submission.baseSeq === 0
			? t("outlinePlan.summaryFirst", { version: root.round, added: counts.added })
			: t("outlinePlan.summary", {
					version: root.round,
					added: counts.added,
					changed,
					removed: counts.removed,
				});
	const shortSummary =
		submission.baseSeq === 0
			? t("outlinePlan.summaryFirstShort", { version: root.round, added: counts.added })
			: t("outlinePlan.summaryShort", {
					version: root.round,
					added: counts.added,
					changed,
					removed: counts.removed,
				});
	const reviewLabel = t("outlinePlan.reviewCount", { count: reviewCount });

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
			{/* One xs line: the review's count, the summary (cut to fit) and the two read-only
			    views, for readers too. Nothing in it is taller than the xs line. */}
			<Group
				ref={summaryRef}
				gap={8}
				mb={4}
				wrap="nowrap"
				align="center"
				data-testid="outline-plan-summary-row"
				data-narrow={narrow ? "" : undefined}
			>
				{reviewCount > 0 && (
					<Tooltip label={reviewLabel} withinPortal>
						<Text
							span
							size="xs"
							c="orange"
							fw={600}
							aria-label={reviewLabel}
							style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 2 }}
							data-testid="outline-plan-review-count"
						>
							<IconMessageCircle size="1.1em" aria-hidden />
							{reviewCount}
						</Text>
					</Tooltip>
				)}
				<Text
					size="xs"
					c="dimmed"
					truncate="end"
					title={fullSummary}
					style={{ flex: 1, minWidth: 0 }}
					data-testid="outline-plan-summary"
				>
					{narrow ? shortSummary : fullSummary}
				</Text>
				{narrow ? (
					<>
						<Tooltip label={t("outlinePlan.viewChanges")} withinPortal>
							<ActionIcon
								size="xs"
								variant="subtle"
								aria-label={t("outlinePlan.viewChanges")}
								onClick={() => setDiffOpen(true)}
								data-testid="outline-plan-view-changes"
							>
								<IconListDetails size={14} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={t("outlinePlan.openInOutline")} withinPortal>
							<ActionIcon
								size="xs"
								variant="subtle"
								aria-label={t("outlinePlan.openInOutline")}
								onClick={openInOutline}
								data-testid="outline-plan-open"
							>
								<IconExternalLink size={14} />
							</ActionIcon>
						</Tooltip>
					</>
				) : (
					<>
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
					</>
				)}
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
				styles={textareaStyle ? { input: textareaStyle } : undefined}
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
