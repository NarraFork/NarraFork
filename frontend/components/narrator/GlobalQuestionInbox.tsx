/** One human-decision center. List queries carry summaries; expanded rows own their forms. */
import type { AsyncQuestion, PendingPermission } from "@frontend/types/narrator";
import {
	Alert,
	Badge,
	Box,
	Button,
	Divider,
	Drawer,
	Group,
	Paper,
	Stack,
	Text,
} from "@mantine/core";
import type { HumanAttentionItem } from "@shared/human-attention";
import { IconClockPause, IconInbox } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { globalQuestionsQueryKey } from "../../hooks/useAsyncQuestions";
import {
	groupHumanAttentionByScope,
	humanAttentionListKey,
	invalidateHumanAttentionDecision,
	isAttentionGone,
	loadedHumanAttentionItems,
	useHumanAttention,
	useHumanAttentionDetail,
} from "../../hooks/useHumanAttention";
import { api } from "../../lib/api";
import { assetUrl } from "../../lib/base-path";
import { readSession, writeSession } from "../../lib/session-store";
import { AskUserQuestionBanner, coerceQuestions } from "./AskUserQuestionBanner";
import { toBannerQuestions } from "./async-question-questions";
import { InlinePermission } from "./InlinePermission";
import { FileModDrawerCtx, PermEnterHintCtx } from "./tool-call-contexts";

/** A global-inbox row: the question plus enough context to say which session it is. */
export interface GlobalQuestion extends AsyncQuestion {
	narratorTitle: string | null;
	chapterId: string | null;
}

export { globalQuestionsQueryKey } from "../../hooks/useAsyncQuestions";

export function useGlobalAsyncQuestions(enabled = true) {
	return useQuery({
		queryKey: globalQuestionsQueryKey,
		queryFn: () => api.getAllAsyncQuestions(),
		enabled,
	});
}

/**
 * Split the inbox into "this session" and "elsewhere".
 *
 * Exported for testing: the grouping is what replaced a whole component, so it is worth
 * pinning that a question is never dropped or double-counted by it.
 */
export function groupQuestionsByScope(
	items: readonly GlobalQuestion[],
	currentNarratorId?: string,
): { current: GlobalQuestion[]; others: GlobalQuestion[] } {
	return groupHumanAttentionByScope(items, currentNarratorId);
}

interface InboxButtonProps {
	currentNarratorId?: string;
	variant?: "row" | "compact";
}

export function HumanAttentionInboxButton({
	currentNarratorId,
	variant = "row",
}: InboxButtonProps) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	const query = useHumanAttention();
	const items = loadedHumanAttentionItems(query.data?.pages);
	const { current, others } = groupHumanAttentionByScope(items, currentNarratorId);
	const blocking = items.filter((item) => item.blocking).length;
	const count = `${items.length}${query.hasNextPage ? "+" : ""}`;

	// A failed first load is unknown, not an authoritative empty inbox. Keep a retry entry.
	if (!opened && items.length === 0 && !query.hasNextPage && !query.isError) return null;
	return (
		<>
			{(items.length > 0 || query.hasNextPage || query.isError) && (
				<Button
					size={variant === "compact" ? "compact-xs" : "compact-sm"}
					fullWidth={variant === "row"}
					justify={variant === "row" ? "flex-start" : undefined}
					variant={blocking > 0 ? "light" : "subtle"}
					color={blocking > 0 ? "yellow" : "gray"}
					leftSection={blocking > 0 ? <IconClockPause size={14} /> : <IconInbox size={14} />}
					onClick={() => setOpened(true)}
					aria-label={t("humanAttentionOpen", { count })}
				>
					<Group gap={6} wrap="wrap">
						<Text size="xs">
							{query.isError && !items.length
								? t("humanAttentionLoadError")
								: t("humanAttentionBadge", { count })}
						</Text>
						{currentNarratorId && items.length > 0 && (
							<Text size="xs">
								{t("inboxBadgeSplit", { current: current.length, others: others.length })}
							</Text>
						)}
						{blocking > 0 && (
							<Text size="xs" fw={600}>
								{t("inboxBadgeAwaitedSuffix", { count: blocking })}
							</Text>
						)}
					</Group>
				</Button>
			)}
			<HumanAttentionInboxDrawer
				opened={opened}
				onClose={() => setOpened(false)}
				currentNarratorId={currentNarratorId}
			/>
		</>
	);
}

const noop = () => {};
const isolatedPermissionKeys = {
	focusIndex: null,
	setFocusIndex: noop,
	setButtonCount: noop,
	setHasFeedback: noop,
	registerActions: noop,
	activePermissionId: null,
};

export function HumanAttentionInboxDrawer({
	opened,
	onClose,
	currentNarratorId,
}: {
	opened: boolean;
	onClose: () => void;
	currentNarratorId?: string;
}) {
	const { t } = useTranslation("narrator");
	const client = useQueryClient();
	const query = useHumanAttention(opened);
	const items = loadedHumanAttentionItems(query.data?.pages);
	const { current, others } = groupHumanAttentionByScope(items, currentNarratorId);
	useEffect(() => {
		if (opened)
			void client.invalidateQueries({ queryKey: humanAttentionListKey }, { cancelRefetch: false });
	}, [client, opened]);
	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="right"
			size="lg"
			title={
				<Group gap="xs">
					<IconInbox size={18} />
					<Text fw={500}>{t("humanAttentionTitle")}</Text>
					{(items.length > 0 || query.hasNextPage) && (
						<Badge size="sm" variant="light">
							{items.length}
							{query.hasNextPage ? "+" : ""}
						</Badge>
					)}
				</Group>
			}
		>
			<PermEnterHintCtx.Provider value={isolatedPermissionKeys}>
				{/* Stop portal events before they reach the session's composer shortcuts. */}
				<Stack
					gap="lg"
					onKeyDown={(event) => {
						if (["Enter", "ArrowLeft", "ArrowRight"].includes(event.key)) event.stopPropagation();
					}}
				>
					<Text size="xs" c="dimmed">
						{t("humanAttentionDesc")}
					</Text>
					{query.isLoading && <Text size="sm">{t("humanAttentionLoading")}</Text>}
					{query.isError && (
						<RetryNotice
							message={t("humanAttentionLoadError")}
							retry={() => void query.refetch()}
							busy={query.isFetching}
						/>
					)}
					{!query.isLoading && !query.isError && !query.hasNextPage && !items.length && (
						<Text size="sm" c="dimmed">
							{t("humanAttentionEmpty")}
						</Text>
					)}
					{current.length > 0 && (
						<Stack gap="sm" data-attention-scope="current">
							<Text size="xs" fw={600} c="dimmed">
								{t("inboxGroupCurrentSession")}
							</Text>
							{current.map((item) => (
								<HumanAttentionRow key={item.id} item={item} />
							))}
						</Stack>
					)}
					{current.length > 0 && others.length > 0 && <Divider />}
					{others.length > 0 && (
						<Stack gap="sm" data-attention-scope="others">
							{currentNarratorId && (
								<Text size="xs" fw={600} c="dimmed">
									{t("inboxGroupOtherSessions")}
								</Text>
							)}
							{others.map((item) => (
								<HumanAttentionRow key={item.id} item={item} />
							))}
						</Stack>
					)}
					{query.hasNextPage && (
						<Button
							variant="light"
							loading={query.isFetchingNextPage}
							onClick={() => void query.fetchNextPage()}
						>
							{t("humanAttentionLoadMore")}
						</Button>
					)}
				</Stack>
			</PermEnterHintCtx.Provider>
		</Drawer>
	);
}

function RetryNotice({
	message,
	retry,
	busy,
}: {
	message: string;
	retry: () => void;
	busy?: boolean;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Alert color="red">
			<Text size="sm">{message}</Text>
			<Button mt="xs" size="xs" variant="light" onClick={retry} loading={busy}>
				{t("humanAttentionRetry")}
			</Button>
		</Alert>
	);
}

function ownerHref(narratorId: string) {
	return assetUrl(`/narrators/${encodeURIComponent(narratorId)}`);
}

function OwnerLink({ item }: { item: HumanAttentionItem }) {
	const { t } = useTranslation("narrator");
	return (
		<Button
			component="a"
			href={ownerHref(item.narratorId)}
			target="_blank"
			rel="noopener noreferrer"
			size="compact-xs"
			variant="subtle"
		>
			{t("humanAttentionOpenSession")}
		</Button>
	);
}

function HumanAttentionRow({ item }: { item: HumanAttentionItem }) {
	const { t } = useTranslation("narrator");
	const [expanded, setExpanded] = useState(false);
	return (
		<Paper withBorder p="sm" data-attention-id={item.id}>
			<Stack gap="xs">
				<Group gap="xs">
					<Badge size="xs" variant="light">
						{t(`humanAttentionKind.${item.kind}`)}
					</Badge>
					<Badge size="xs" color={item.blocking ? "yellow" : "gray"}>
						{t(item.blocking ? "humanAttentionBlocking" : "humanAttentionLater")}
					</Badge>
					{!item.canAct && (
						<Badge size="xs" color="gray" variant="outline">
							{t("humanAttentionReadOnly")}
						</Badge>
					)}
				</Group>
				<Text size="sm" style={{ overflowWrap: "anywhere" }}>
					{item.summary ||
						t(
							item.source === "question"
								? item.blocking
									? "asyncQuestionAwaitedNotice"
									: "asyncQuestionInboxTitle"
								: `humanAttentionKind.${item.kind}`,
						)}
				</Text>
				<Text size="xs" c="dimmed">
					{t("humanAttentionSource", {
						tool: item.toolName,
						narrator: item.narratorTitle || item.narratorId,
					})}
				</Text>
				<Group justify="space-between">
					<Button
						size="compact-xs"
						variant="light"
						aria-expanded={expanded}
						onClick={() => setExpanded((value) => !value)}
					>
						{t(expanded ? "humanAttentionCollapse" : "humanAttentionReview")}
					</Button>
					<OwnerLink item={item} />
				</Group>
				{expanded && <HumanAttentionForm item={item} />}
			</Stack>
		</Paper>
	);
}

/** Full input, including every reflection suggestion. Never substitute the parent device. */
function PermissionReviewContext({
	permission,
	previewPlan,
}: {
	permission: PendingPermission;
	previewPlan: string | null;
}) {
	const { t } = useTranslation("narrator");
	const input: unknown = permission.inputJson;
	const record =
		input && typeof input === "object" && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: null;
	const plan =
		permission.toolName === "ExitPlanMode" && typeof record?.plan === "string" ? record.plan : null;
	// Commands and file content need literal line breaks, not JSON's escaped strings.
	const labels = {
		command: "humanAttentionCommand",
		file_path: "humanAttentionPath",
		content: "humanAttentionContent",
		old_string: "humanAttentionOld",
		new_string: "humanAttentionNew",
	};
	const fields = Object.entries(labels).filter(([key]) => typeof record?.[key] === "string");
	const remaining = record
		? Object.fromEntries(
				Object.entries(record).filter(
					([key]) => !(key === "plan" && plan !== null) && !fields.some(([field]) => field === key),
				),
			)
		: input;
	const hasRemaining = !record || Object.keys(remaining as Record<string, unknown>).length > 0;
	const target = permission.executionTargets?.length
		? permission.executionTargets
		: permission.executionTarget
			? [permission.executionTarget]
			: null;
	return (
		<Stack gap="xs">
			{plan !== null && <ReviewText label={t("humanAttentionPlan")} value={previewPlan ?? plan} />}
			{fields.map(([key, label]) => (
				<ReviewText key={key} label={t(label)} value={record?.[key]} />
			))}
			{hasRemaining && <ReviewText label={t("humanAttentionInput")} value={remaining} />}
			{permission.decisionReason && (
				<ReviewText label={t("humanAttentionReason")} value={permission.decisionReason} />
			)}
			{permission.suggestions?.length ? (
				<ReviewText label={t("humanAttentionConsequences")} value={permission.suggestions} />
			) : null}
			<ReviewText
				label={t("executionTarget")}
				value={
					target ?? {
						executionDeviceId: permission.executionDeviceId ?? null,
						executionCwd: permission.executionCwd ?? null,
						resolvedFilePath: permission.resolvedFilePath ?? null,
						deviceSelectionSource: permission.deviceSelectionSource ?? null,
					}
				}
			/>
		</Stack>
	);
}

function ReviewText({ label, value }: { label: string; value: unknown }) {
	return (
		<Box>
			<Text size="xs" fw={600}>
				{label}
			</Text>
			<Text
				component="pre"
				size="xs"
				style={{
					whiteSpace: "pre-wrap",
					overflowWrap: "anywhere",
					maxHeight: 400,
					overflow: "auto",
					margin: 0,
				}}
			>
				{typeof value === "string" ? value : JSON.stringify(value, null, 2)}
			</Text>
		</Box>
	);
}

function HumanAttentionForm({ item: summary }: { item: HumanAttentionItem }) {
	const { t } = useTranslation("narrator");
	const client = useQueryClient();
	const query = useHumanAttentionDetail(summary.id);
	const item = query.data?.item ?? summary;
	const permission = query.data?.permission;
	const question = query.data?.question;
	const [previewPlan, setPreviewPlan] = useState<string | null>(null);
	const preview = useCallback((_id: string, plan: string | null) => setPreviewPlan(plan), []);
	const actionLock = useRef(false);
	const drafts = useRef<{ kind: "ask-draft" | "permission-draft"; id: string; value: string }[]>(
		[],
	);
	const captureDrafts = useCallback(() => {
		// Never overwrite the pre-submit snapshot after a descendant has begun clearing it.
		if (actionLock.current) return;
		const kind =
			question || permission?.toolName === "AskUserQuestion" ? "ask-draft" : "permission-draft";
		const ids = new Set([item.toolCallId, item.requestId]);
		drafts.current = [...ids].flatMap((id) => {
			const value = readSession(kind, id);
			return value === null ? [] : [{ kind, id, value }];
		});
	}, [question, permission?.toolName, item.toolCallId, item.requestId]);
	useEffect(captureDrafts, [captureDrafts]);
	const mutation = useMutation({
		mutationFn: (action: () => Promise<unknown>) => action(),
		onError: () => {
			// Existing forms clear storage on submit. Restore it if the original endpoint failed.
			for (const draft of drafts.current) writeSession(draft.kind, draft.id, draft.value);
		},
		onSettled: async () => {
			try {
				await invalidateHumanAttentionDecision(client, item);
			} finally {
				actionLock.current = false;
			}
		},
	});
	const run = async (action: () => Promise<unknown>) => {
		if (
			actionLock.current ||
			!summary.canAct ||
			!item.canAct ||
			query.isFetching ||
			query.data?.tooLarge
		)
			return;
		actionLock.current = true;
		try {
			await mutation.mutateAsync(action);
		} catch {
			/* Inline retry notice keeps the request and draft. */
		}
	};
	const fileDrawer = useMemo(
		() => ({
			// The inbox has no workspace file drawer; open the ACTUAL owner rather than a noop or parent.
			openForApproval: () =>
				window.open(ownerHref(item.narratorId), "_blank", "noopener,noreferrer"),
		}),
		[item.narratorId],
	);

	if (query.isLoading) return <Text size="sm">{t("humanAttentionLoading")}</Text>;
	if (query.isError)
		return (
			<RetryNotice
				message={t(isAttentionGone(query.error) ? "humanAttentionGone" : "humanAttentionLoadError")}
				retry={() => void query.refetch()}
				busy={query.isFetching}
			/>
		);
	if (query.data?.tooLarge || (!question && !permission))
		return (
			<Alert color="yellow">
				<Text size="sm">
					{t(query.data?.tooLarge ? "humanAttentionTooLarge" : "humanAttentionUnavailable")}
				</Text>
				<OwnerLink item={item} />
			</Alert>
		);
	const readOnly = !summary.canAct || !item.canAct;
	return (
		<Stack gap="sm">
			<Text size="xs" c="dimmed">
				{t("humanAttentionOwner", { narrator: item.narratorId, request: item.requestId })}
			</Text>
			{permission?.subagentNarratorId && (
				<Text size="xs" c="dimmed">
					{t("humanAttentionChild", { narrator: permission.subagentNarratorId })}
				</Text>
			)}
			{permission && <PermissionReviewContext permission={permission} previewPlan={previewPlan} />}
			{readOnly && (
				<Text size="sm" c="dimmed">
					{t("humanAttentionReadOnlyNotice")}
				</Text>
			)}
			{mutation.isError && (
				<RetryNotice
					message={`${t(isAttentionGone(mutation.error) ? "humanAttentionGone" : "humanAttentionDecisionError")} ${mutation.error.message}`}
					retry={() => void query.refetch()}
					busy={query.isFetching}
				/>
			)}
			<Box
				component="fieldset"
				disabled={mutation.isPending || query.isFetching}
				style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
				onClickCapture={captureDrafts}
				onKeyDownCapture={captureDrafts}
				aria-busy={mutation.isPending}
			>
				{question ? (
					<AskUserQuestionBanner
						requestId={item.requestId}
						draftId={question.toolCallId}
						questions={toBannerQuestions(question.questions)}
						readOnly={readOnly}
						busy={mutation.isPending}
						denyLabel={t("asyncQuestionDismiss")}
						onSubmit={(_id, answers) =>
							void run(() =>
								api.answerAsyncQuestion(item.narratorId, item.requestId, {
									answers,
									...(question.annotations ? { annotations: question.annotations } : {}),
								}),
							)
						}
						onDeny={() => void run(() => api.dismissAsyncQuestion(item.narratorId, item.requestId))}
					/>
				) : permission?.toolName === "AskUserQuestion" ? (
					<AskUserQuestionBanner
						requestId={item.requestId}
						draftId={item.toolCallId}
						questions={coerceQuestions(permission.inputJson?.questions)}
						readOnly={readOnly}
						busy={mutation.isPending}
						reflectionDeadline={permission.reflectionDeadline}
						onSubmit={(_id, answers) =>
							void run(() => api.approvePermission(item.requestId, { answers }))
						}
						onDeny={() => void run(() => api.denyPermission(item.requestId))}
						onDefer={() => run(() => api.deferPermissionQuestion(item.requestId))}
						// As with submit, the shared mutation owns busy/error state and restores
						// the draft after a failed request; the banner may clear its draft now.
						onReflect={() => void run(() => api.reflectQuestion(item.requestId))}
					/>
				) : permission && !readOnly ? (
					<FileModDrawerCtx.Provider value={fileDrawer}>
						<InlinePermission
							permission={{ ...permission, id: item.requestId }}
							onPlanPreviewChange={preview}
							onDecision={(_id, decision, feedbackText, compactAfter, updatedPlan) =>
								void run(() =>
									decision === "allow"
										? api.approvePermission(item.requestId, {
												feedbackText,
												compactAfter,
												updatedPlan,
											})
										: api.denyPermission(item.requestId, { feedbackText }),
								)
							}
						/>
					</FileModDrawerCtx.Provider>
				) : null}
			</Box>
		</Stack>
	);
}

// Temporary compatibility names: these are aliases of the SAME center, not a second inbox.
export const AsyncQuestionInboxButton = HumanAttentionInboxButton;
export const AsyncQuestionInboxDrawer = HumanAttentionInboxDrawer;
