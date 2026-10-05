/** One human-decision center. List queries carry summaries; expanded rows own their forms. */

import type { ExecutionTargetIdentity } from "@frontend/lib/api/types";
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
import {
	getReflectionSuggestion,
	type ReflectionKind,
	type ReflectionStatus,
	reflectionTitleKeyPrefix,
	reflectionTitleKeySuffix,
} from "@shared/pretext-layout/reflection";
import { IconClockPause, IconInbox } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	createContext,
	lazy,
	type ReactNode,
	Suspense,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { globalQuestionsQueryKey } from "../../../hooks/useAsyncQuestions";
import {
	groupHumanAttentionByScope,
	humanAttentionListKey,
	invalidateHumanAttentionDecision,
	isAttentionGone,
	loadedHumanAttentionItems,
	useHumanAttention,
	useHumanAttentionDetail,
} from "../../../hooks/useHumanAttention";
import { useMobileDrawerHistory } from "../../../hooks/useMobileDrawerHistory";
import { api } from "../../../lib/api";
import { readSession, writeSession } from "../../../lib/session-store";
import { FileReferenceScopeProvider } from "../composer/FileReferenceScope";
import { InlinePermission } from "../permission/InlinePermission";
import { PermEnterHintCtx } from "../tool-call/tool-call-contexts";
import { AskUserQuestionBanner, coerceQuestions } from "./AskUserQuestionBanner";
import { toBannerQuestions } from "./async-question-questions";

/**
 * The markdown renderer the owning session uses, loaded on demand.
 *
 * Lazy because this inbox mounts on the dashboard and in every session header,
 * while a markdown body only appears once a row is expanded. Importing it eagerly
 * would pull react-markdown (plus its remark/rehype chain) into the app shell for
 * users who never open a decision.
 */
const ReviewMarkdownBody = lazy(() =>
	import("../markdown/MarkdownContent").then((m) => ({ default: m.MarkdownContent })),
);

/**
 * File references in a reviewed body render as inert text here.
 *
 * `context: null` (not `undefined`) is what disables path inference: the inbox has
 * no workspace, so a `[path](path)` link has nothing to open. Left unscoped, the
 * relative destination would be treated as an application route and a click would
 * navigate the SPA to a path that does not exist.
 */
const INERT_FILE_REFERENCES = { context: null } as const;

/** A global-inbox row: the question plus enough context to say which session it is. */
export interface GlobalQuestion extends AsyncQuestion {
	narratorTitle: string | null;
	chapterId: string | null;
}

export { globalQuestionsQueryKey } from "../../../hooks/useAsyncQuestions";

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
	const scopeLabels = [
		current.length > 0 ? t("inboxBadgeCurrentSession", { count: current.length }) : null,
		others.length > 0 ? t("inboxBadgeOtherSessions", { count: others.length }) : null,
	].filter((label): label is string => label !== null);

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
						{currentNarratorId && scopeLabels.length > 0 && (
							<Text size="xs">
								{scopeLabels.map((label, index) => (
									<span key={label}>
										{index > 0 ? " · " : null}
										{label}
									</span>
								))}
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
const CloseAttentionContext = createContext<() => void>(noop);
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
	const query = useHumanAttention(opened);
	const items = loadedHumanAttentionItems(query.data?.pages);
	useMobileDrawerHistory(opened, onClose);
	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="right"
			size="lg"
			onKeyDown={(event) => {
				if (["Enter", "ArrowLeft", "ArrowRight"].includes(event.key)) event.stopPropagation();
			}}
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
			{opened && (
				<HumanAttentionInboxContent onClose={onClose} currentNarratorId={currentNarratorId} />
			)}
		</Drawer>
	);
}

/** Shared decision surface. Both drawers use the same authority and private forms. */
export function HumanAttentionInboxContent({
	onClose,
	currentNarratorId,
}: {
	onClose: () => void;
	currentNarratorId?: string;
}) {
	const { t } = useTranslation("narrator");
	const client = useQueryClient();
	const query = useHumanAttention();
	const items = loadedHumanAttentionItems(query.data?.pages);
	const { current, others } = groupHumanAttentionByScope(items, currentNarratorId);
	useEffect(() => {
		void client.invalidateQueries({ queryKey: humanAttentionListKey }, { cancelRefetch: false });
	}, [client]);
	return (
		<CloseAttentionContext.Provider value={onClose}>
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
		</CloseAttentionContext.Provider>
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

function OwnerLink({ item }: { item: HumanAttentionItem }) {
	const { t } = useTranslation("narrator");
	const navigate = useNavigate();
	const onClose = useContext(CloseAttentionContext);
	return (
		<Button
			onClick={() => {
				void navigate({ to: "/narrators/$narratorId", params: { narratorId: item.narratorId } });
				onClose();
			}}
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

/**
 * Decision context for a permission row.
 *
 * Everything here is rendered as LABELLED TEXT, never as a JSON dump. A serialized
 * object is unreadable at exactly the moment a human is being asked to judge it, and
 * it also duplicated content the row already renders properly: an AskUserQuestion's
 * `questions` array appeared verbatim above the real answer form built from it.
 *
 * Consequence of that rule: input keys with no reader here (nested objects/arrays of
 * an unknown tool) are omitted rather than stringified. Scalars are still listed, so
 * the omission is limited to structures the inbox cannot present faithfully; the
 * owning session remains one click away for the complete input.
 */
function PermissionReviewContext({
	permission,
	previewPlan,
	showExecutionTarget,
}: {
	permission: PendingPermission;
	previewPlan: string | null;
	/**
	 * False when the decision form mounted below already draws the frozen target.
	 * `InlinePermission` renders its own target block, and two identical blocks in
	 * one row read as two different routings.
	 */
	showExecutionTarget: boolean;
}) {
	const { t } = useTranslation("narrator");
	const input: unknown = permission.inputJson;
	const record =
		input && typeof input === "object" && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: null;
	const plan =
		permission.toolName === "ExitPlanMode" && typeof record?.plan === "string" ? record.plan : null;
	// The question banner below IS this tool's input; listing it again is pure noise.
	const inputOwnedByForm = permission.toolName === "AskUserQuestion";
	// Commands and file content need literal line breaks, not JSON's escaped strings.
	const labels: Record<string, string> = {
		command: "humanAttentionCommand",
		file_path: "humanAttentionPath",
		content: "humanAttentionContent",
		old_string: "humanAttentionOld",
		new_string: "humanAttentionNew",
	};
	const fields = inputOwnedByForm
		? []
		: Object.entries(labels).filter(([key]) => typeof record?.[key] === "string");
	const scalars =
		record && !inputOwnedByForm
			? Object.entries(record).filter(
					([key, value]) =>
						!(key === "plan" && plan !== null) &&
						!(key in labels) &&
						(typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
				)
			: [];
	const reflection = reviewReflection(permission.suggestions);
	const targets = showExecutionTarget ? reviewTargets(permission) : [];
	return (
		<Stack gap="xs">
			{plan !== null && (
				<ReviewMarkdown label={t("humanAttentionPlan")} value={previewPlan ?? plan} />
			)}
			{fields.map(([key, label]) => (
				<ReviewText key={key} label={t(label)} value={String(record?.[key])} />
			))}
			{scalars.map(([key, value]) => (
				<ReviewText key={key} label={key} value={String(value)} />
			))}
			{permission.decisionReason && (
				<ReviewText label={t("humanAttentionReason")} value={permission.decisionReason} />
			)}
			{reflection && (
				<ReflectionReviewCard reflection={reflection} decisionReason={permission.decisionReason} />
			)}
			{targets.map((target, index) => (
				<ExecutionTargetCard
					// biome-ignore lint/suspicious/noArrayIndexKey: targets are a stable ordered list
					key={index}
					target={target}
				/>
			))}
		</Stack>
	);
}

/** Reflection gate context, flattened to the fields a human decision actually needs. */
interface ReviewReflection {
	kind: ReflectionKind;
	status: ReflectionStatus;
	reason?: string;
	nextSteps?: string;
	severity?: string;
	summary?: string;
	consequences: string[];
	alternatives: string[];
	details: string[];
	mutations: ReviewTaskMutation[];
}

interface ReviewTaskMutation {
	kind?: string;
	text?: string;
	fromStatus?: string;
	toStatus?: string;
	details?: string;
	createdBy?: string;
}

const asStrings = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value ? value : undefined;

/**
 * Parse the reflection entry plus the two payloads only the raw suggestion carries:
 * `danger` (consequences / safer alternatives) and `mutations` (proposed protected
 * task changes). Both are the substance of the gate, so they get real rows.
 */
function reviewReflection(suggestions: unknown[] | undefined): ReviewReflection | null {
	const parsed = getReflectionSuggestion(suggestions);
	if (!parsed) return null;
	const raw = (suggestions ?? []).find(
		(entry): entry is Record<string, unknown> =>
			!!entry &&
			typeof entry === "object" &&
			(entry as Record<string, unknown>).type === parsed.kind,
	);
	const danger =
		parsed.danger && typeof parsed.danger === "object"
			? (parsed.danger as Record<string, unknown>)
			: null;
	const mutations = Array.isArray(raw?.mutations)
		? raw.mutations.filter(
				(entry): entry is ReviewTaskMutation => !!entry && typeof entry === "object",
			)
		: [];
	return {
		kind: parsed.kind,
		status: parsed.status,
		...(parsed.reason ? { reason: parsed.reason } : {}),
		...(parsed.nextSteps ? { nextSteps: parsed.nextSteps } : {}),
		...(asString(danger?.severity) ? { severity: asString(danger?.severity) } : {}),
		...(asString(danger?.summary) ? { summary: asString(danger?.summary) } : {}),
		consequences: asStrings(danger?.consequences),
		alternatives: asStrings(danger?.saferAlternatives),
		details: asStrings(danger?.details),
		mutations,
	};
}

function ReflectionReviewCard({
	reflection,
	decisionReason,
}: {
	reflection: ReviewReflection;
	decisionReason?: string;
}) {
	const { t } = useTranslation("narrator");
	const title = t(
		`${reflectionTitleKeyPrefix(reflection.kind)}Reflection${reflectionTitleKeySuffix(reflection.status)}`,
	);
	// The server already promotes the reflection reason to `decisionReason`; showing
	// the identical sentence twice reads as two separate findings.
	const reason = reflection.reason === decisionReason ? undefined : reflection.reason;
	return (
		<Paper withBorder p="xs" radius="sm">
			<Stack gap={4}>
				<Group gap="xs" wrap="wrap">
					<Text size="xs" fw={600}>
						{title}
					</Text>
					{reflection.severity && (
						<Badge size="xs" variant="light" color="orange">
							{t(`humanAttentionSeverity_${reflection.severity}`, {
								defaultValue: reflection.severity,
							})}
						</Badge>
					)}
				</Group>
				{reflection.summary && <ReviewLine value={reflection.summary} />}
				{reason && <ReviewLine value={reason} />}
				{reflection.nextSteps && (
					<ReviewLine value={t("reflectionNextSteps", { nextSteps: reflection.nextSteps })} />
				)}
				<ReviewBullets
					label={t("humanAttentionDangerConsequences")}
					items={reflection.consequences}
				/>
				<ReviewBullets
					label={t("humanAttentionDangerAlternatives")}
					items={reflection.alternatives}
				/>
				<ReviewBullets label={t("humanAttentionDangerDetails")} items={reflection.details} />
				{reflection.mutations.length > 0 && (
					<Stack gap={2}>
						<Text size="xs" fw={600}>
							{t("humanAttentionTaskChanges")}
						</Text>
						{reflection.mutations.map((mutation, index) => (
							<TaskMutationRow
								// biome-ignore lint/suspicious/noArrayIndexKey: mutations are a stable ordered list
								key={index}
								mutation={mutation}
							/>
						))}
					</Stack>
				)}
			</Stack>
		</Paper>
	);
}

function TaskMutationRow({ mutation }: { mutation: ReviewTaskMutation }) {
	const { t } = useTranslation("narrator");
	const kind = asString(mutation.kind);
	const from = asString(mutation.fromStatus);
	const to = asString(mutation.toStatus);
	const statusLabel = (status: string) =>
		t(`spec.status.${status}`, { defaultValue: t(`humanAttentionTaskStatus_${status}`, status) });
	return (
		<Box>
			<Group gap={6} wrap="wrap">
				{kind && (
					<Badge size="xs" variant="light">
						{t(`humanAttentionTaskMutation_${kind}`, { defaultValue: kind })}
					</Badge>
				)}
				{from && to && (
					<Text size="xs" c="dimmed">
						{t("humanAttentionTaskStatusChange", {
							from: statusLabel(from),
							to: statusLabel(to),
						})}
					</Text>
				)}
				{mutation.createdBy && (
					<Text size="xs" c="dimmed">
						{t("humanAttentionTaskCreatedBy", {
							by: t(`humanAttentionCreatedBy_${mutation.createdBy}`, {
								defaultValue: mutation.createdBy,
							}),
						})}
					</Text>
				)}
			</Group>
			{mutation.text && <ReviewLine value={mutation.text} />}
			{mutation.details && <ReviewLine value={mutation.details} />}
		</Box>
	);
}

/**
 * Frozen execution target(s), rendered like the session's own permission form.
 *
 * Nothing is drawn when no device was captured. The old code stringified the
 * fallback object instead, so a permission with no routing produced a block of
 * four `null`s — noise that read like a malfunction.
 */
function reviewTargets(permission: PendingPermission): ExecutionTargetIdentity[] {
	if (permission.executionTargets?.length) return permission.executionTargets;
	if (permission.executionTarget) return [permission.executionTarget];
	if (!permission.executionDeviceId) return [];
	return [
		{
			deviceId: permission.executionDeviceId,
			cwd: permission.executionCwd ?? "",
			...(permission.resolvedFilePath ? { lexicalPath: permission.resolvedFilePath } : {}),
			...(permission.deviceSelectionSource
				? { selectionSource: permission.deviceSelectionSource }
				: {}),
		},
	];
}

function ExecutionTargetCard({ target }: { target: ExecutionTargetIdentity }) {
	const { t } = useTranslation("narrator");
	return (
		<Paper withBorder p="xs" radius="sm">
			<Group gap="xs" wrap="wrap" mb={target.cwd || target.lexicalPath ? 4 : 0}>
				<Text size="xs" fw={600}>
					{t("executionTarget")}
				</Text>
				<Badge size="xs" variant="light" color={target.deviceId === "local" ? "gray" : "indigo"}>
					{target.deviceId === "local" ? t("executionTargetLocal") : target.deviceId}
				</Badge>
				{target.selectionSource && (
					<Badge size="xs" variant="outline" color="gray">
						{t(`toolCallInspector.executionTarget.${target.selectionSource}`)}
					</Badge>
				)}
				{target.pathFlavor && (
					<Badge size="xs" variant="outline" color="blue">
						{t("executionTargetPathFlavor", { flavor: target.pathFlavor })}
					</Badge>
				)}
				{target.runtimeGeneration != null && (
					<Badge size="xs" variant="outline" color="grape">
						{t("executionTargetRuntimeGeneration", { generation: target.runtimeGeneration })}
					</Badge>
				)}
			</Group>
			{target.cwd && <ReviewLine value={t("executionTargetCwd", { cwd: target.cwd })} />}
			{target.lexicalPath && (
				<ReviewLine value={t("executionTargetLexicalPath", { path: target.lexicalPath })} />
			)}
			{target.canonicalPath && (
				<ReviewLine value={t("executionTargetCanonicalPath", { path: target.canonicalPath })} />
			)}
		</Paper>
	);
}

function ReviewLine({ value }: { value: string }) {
	return (
		<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
			{value}
		</Text>
	);
}

function ReviewBullets({ label, items }: { label: string; items: string[] }) {
	if (items.length === 0) return null;
	return (
		<Stack gap={2}>
			<Text size="xs" fw={600}>
				{label}
			</Text>
			{items.map((item) => (
				<ReviewLine key={item} value={`· ${item}`} />
			))}
		</Stack>
	);
}

/** Shared label + bounded scroll box, so a plan and a command frame identically. */
function ReviewBlock({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Box>
			<Text size="xs" fw={600}>
				{label}
			</Text>
			<Box style={{ maxHeight: 400, overflow: "auto" }}>{children}</Box>
		</Box>
	);
}

/**
 * Preformatted text: literal line breaks, never escaped JSON, never markdown.
 *
 * Commands, paths and file content are the LITERAL bytes about to be run or
 * written. Rendering those as markdown would be a lie about what was requested —
 * `**` in a shell command is a glob, and a `#` line in a config file is a comment,
 * not a heading. Only bodies the model authored as prose get `ReviewMarkdown`.
 */
function ReviewText({ label, value }: { label: string; value: string }) {
	return (
		<ReviewBlock label={label}>
			<Text
				component="pre"
				size="xs"
				style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}
			>
				{value}
			</Text>
		</ReviewBlock>
	);
}

/**
 * A model-authored prose body (currently the ExitPlanMode plan), rendered as the
 * markdown it is.
 *
 * The owning session renders this exact string through `MarkdownContent`, so the
 * inbox showing raw source meant the same plan read as two different documents
 * depending on where you approved it — headings as `#`, emphasis as `**`, and
 * fenced code as indented noise, which is worst for the longest plans that most
 * need a human to read them carefully.
 *
 * Falls back to preformatted text while the chunk loads and if it fails to load:
 * an unreadable plan is better than an empty approval form.
 */
function ReviewMarkdown({ label, value }: { label: string; value: string }) {
	return (
		<ReviewBlock label={label}>
			<Suspense
				fallback={
					<Text
						component="pre"
						size="xs"
						style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}
					>
						{value}
					</Text>
				}
			>
				<FileReferenceScopeProvider value={INERT_FILE_REFERENCES}>
					<ReviewMarkdownBody text={value} />
				</FileReferenceScopeProvider>
			</Suspense>
		</ReviewBlock>
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
	// Where the tool would run only means something for tools that run somewhere:
	// a question and a plan approval route nowhere, which is why InlinePermission
	// suppresses the block for ExitPlanMode too. Otherwise let the mounted form own
	// it, and draw it here only when no form will (read-only rows).
	const showExecutionTarget =
		!!permission &&
		permission.toolName !== "AskUserQuestion" &&
		permission.toolName !== "ExitPlanMode" &&
		(readOnly || !!question);
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
			{permission && (
				<PermissionReviewContext
					permission={permission}
					previewPlan={previewPlan}
					showExecutionTarget={showExecutionTarget}
				/>
			)}
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
				) : null}
			</Box>
		</Stack>
	);
}

// Temporary compatibility names: these are aliases of the SAME center, not a second inbox.
export const AsyncQuestionInboxButton = HumanAttentionInboxButton;
export const AsyncQuestionInboxDrawer = HumanAttentionInboxDrawer;
