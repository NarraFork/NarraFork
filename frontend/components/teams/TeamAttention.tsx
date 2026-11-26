/**
 * 「等你处理」 (the redesign R): what waits for this member, acted on in place. The only saturated
 * area of the page (amber), hidden when nothing waits.
 *
 * One card per entry (`team-page-model.ts:attentionEntries`):
 *   - a tool call: who asks, the command or path, 拒绝 / 批准 (the ordinary permission routes);
 *   - a question: its text and options, plus 自己写…; a question with several parts, or several
 *     choices, opens its full form in a dialog. The options come from the attention inbox's
 *     detail read (per card, with the caller's access to that session);
 *   - a plan: its title, 看计划 (the plan text in a dialog) and 批准;
 *   - a rule request: answered in its session (open it);
 *   - a ready item: +/-, files, the review verdict, branch → base, 查看改动 / 退回 / 合并 (M:
 *     `TeamMerge.tsx`'s button — 正在合并…, disabled with its reason — and the newest outcome as a
 *     badge: conflicts (退回 opens the reason prefilled), or a prepared merge (去快进 opens the
 *     drawer, where the fast-forward and the command are)).
 *
 * More than {@link ATTENTION_SHOWN}: the rest folds into 「还有 N 条」. Hovering a card highlights
 * its work item in the list. On a phone the cards scroll sideways.
 */

import { useApprovalDetail, useDecideApproval } from "@frontend/hooks/useTeams";
import { formatSmartTime } from "@frontend/lib/format";
import {
	Badge,
	Box,
	Button,
	Code,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	ThemeIcon,
	UnstyledButton,
} from "@mantine/core";
import type {
	TeamPendingApproval,
	TeamQuestionForm,
	TeamWorkDiffStat,
} from "@shared/project-teams";
import {
	IconCheck,
	IconChevronDown,
	IconGitBranch,
	IconHelpCircle,
	IconListCheck,
	IconShieldQuestion,
	IconTerminal2,
} from "@tabler/icons-react";
import { lazy, type ReactNode, Suspense, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskUserQuestionBanner, coerceQuestions } from "../narrator/question/AskUserQuestionBanner";
import { MergeButton } from "./TeamMerge";
import {
	type AttentionEntry,
	type AttentionSource,
	attentionView,
	toolVerb,
} from "./team-page-model";
import {
	ATTENTION_BG,
	ATTENTION_BORDER,
	ATTENTION_COLOR,
	ATTENTION_TEXT,
	DiffCount,
	MONO,
	TABULAR,
} from "./team-page-ui";

const MarkdownContent = lazy(() =>
	import("../narrator/markdown/MarkdownContent").then((module) => ({
		default: module.MarkdownContent,
	})),
);

/** Characters of a prompt and of one option's explanation still answered in place. */
const INLINE_PROMPT_CHARS = 600;
const INLINE_OPTION_NOTE_CHARS = 300;

/**
 * Whether a question is answered right on its card: one single-choice question with a few
 * options whose prompt and explanations fit a card. Anything bigger opens the session's form,
 * so nobody answers without having been shown what was asked.
 */
export function fitsInPlace(form: TeamQuestionForm): boolean {
	return (
		!form.multiSelect &&
		form.options.length > 0 &&
		form.options.length <= INLINE_OPTIONS &&
		(form.description?.length ?? 0) <= INLINE_PROMPT_CHARS &&
		form.optionDescriptions.every((note) => (note?.length ?? 0) <= INLINE_OPTION_NOTE_CHARS)
	);
}

/** Options a question card shows inline before its full form is needed. */
const INLINE_OPTIONS = 4;

export interface AttentionActions {
	teamId: string;
	/** The project the cards belong to (the merge button's API path). */
	projectId?: string;
	/** The base the team's branches merge into (for the merge card). */
	base: string;
	stats: Record<string, TeamWorkDiffStat | null> | undefined;
	onHover?: (itemId: string | null) => void;
	onOpenItem: (itemId: string, options?: { returning?: boolean }) => void;
	onOpenSession?: (narratorId: string) => void;
	/** R2 (the project page): open the team a card comes from. */
	onOpenTeam?: (teamId: string) => void;
	/** Called after a decision is sent (the project page refetches what the card fed). */
	onDecided?: (entry: AttentionEntry) => void;
}

const KIND_ICON = {
	tool: IconTerminal2,
	question: IconHelpCircle,
	plan: IconListCheck,
	rule: IconShieldQuestion,
	merge: IconGitBranch,
} as const;

/** The team a card comes from on the project page: its name, which opens the team. */
function SourceTeam({
	source,
	onOpenTeam,
}: {
	source: Extract<AttentionSource, { kind: "team" }>;
	onOpenTeam?: (teamId: string) => void;
}) {
	return (
		<>
			<UnstyledButton
				onClick={() => onOpenTeam?.(source.teamId)}
				disabled={!onOpenTeam}
				data-testid="attention-source-team"
				style={{ fontWeight: 700 }}
			>
				{source.name}
			</UnstyledButton>
			<Text component="span" inherit c="dimmed">
				{" · "}
			</Text>
		</>
	);
}

/**
 * Who asks: the work item's title (its worker asks), or the coordinator, or the session. On the
 * project page a team's card starts with the team's name, a session's ends with whose it is.
 */
function Asker({
	entry,
	onOpenSession,
	onOpenTeam,
}: {
	entry: Exclude<AttentionEntry, { kind: "merge" }>;
	onOpenSession?: (narratorId: string) => void;
	onOpenTeam?: (teamId: string) => void;
}) {
	const { t } = useTranslation("projects");
	const source = entry.source;
	// An ordinary session asks for itself (or its helper does): no coordinator, no worker.
	const plain = source?.kind === "session";
	const coordinator = entry.approval.depth === 0;
	const who = plain
		? coordinator
			? (source.title ?? entry.approval.agent.title ?? entry.approval.agent.id)
			: (entry.approval.agent.title ?? entry.approval.agent.id)
		: coordinator
			? t("teams.page.attention.coordinator")
			: (entry.item?.title ?? entry.approval.agent.title ?? entry.approval.agent.id);
	const generic = plain || coordinator;
	// A tool call says what it asks for (「请求编辑文件」, 「请求运行命令」), not the tool's name.
	const action = t(`teams.page.attention.toolVerbs.${toolVerb(entry.approval.toolName)}`, {
		tool: entry.approval.toolName,
	});
	const asks =
		entry.kind === "tool"
			? generic
				? action
				: t("teams.page.attention.workerAsksAction", { action })
			: t(
					`teams.page.attention.${
						{
							question: generic ? "coordinatorAsksQuestion" : "asksQuestion",
							plan: generic ? "coordinatorAsksPlan" : "asksPlan",
							rule: generic ? "coordinatorAsksRule" : "asksRule",
						}[entry.kind]
					}`,
				);
	const reason = entry.approval.decisionReason;
	return (
		<>
			<Text size="sm" style={{ overflowWrap: "anywhere" }}>
				{source?.kind === "team" && <SourceTeam source={source} onOpenTeam={onOpenTeam} />}
				{/* The name opens the asking session (the coordinator's is this page's conversation). */}
				<UnstyledButton
					onClick={() => onOpenSession?.(entry.approval.agent.id)}
					disabled={!onOpenSession}
					title={t("teams.page.attention.openAsker")}
					data-testid="team-approval-asker"
					style={{
						fontWeight: 700,
						textDecoration: onOpenSession ? "underline dotted" : undefined,
					}}
				>
					{who}
				</UnstyledButton>{" "}
				{asks}{" "}
				<Text component="span" size="xs" c="dimmed" title={entry.approval.createdAt}>
					{formatSmartTime(entry.approval.createdAt)}
					{plain &&
						source.ownerName &&
						` · ${t("page.attention.ownersSession", { name: source.ownerName })}`}
				</Text>
			</Text>
			{reason && entry.kind === "tool" && (
				<Text
					size="xs"
					c="dimmed"
					style={{ overflowWrap: "anywhere" }}
					data-testid="team-approval-reason"
				>
					{reason}
				</Text>
			)}
		</>
	);
}

function useDecision(
	teamId: string,
	approval: TeamPendingApproval,
	onDecided: (() => void) | undefined,
) {
	const { t } = useTranslation("projects");
	const decide = useDecideApproval(teamId);
	const [sent, setSent] = useState(false);
	const [failed, setFailed] = useState(false);
	const send = (decision: "allow" | "deny", answers?: Record<string, string>) =>
		decide.mutate(
			{ requestId: approval.id, decision, answers },
			{
				onSuccess: () => {
					setSent(true);
					setFailed(false);
					onDecided?.();
				},
				onError: () => setFailed(true),
			},
		);
	const note = sent ? (
		<Text size="xs" c="dimmed">
			{t("teams.page.attention.decided")}
		</Text>
	) : failed ? (
		<Text size="xs" c="red" data-testid="attention-failed">
			{t("teams.page.attention.failed")}
		</Text>
	) : null;
	return { send, sent, pending: decide.isPending, variables: decide.variables, note };
}

function ToolCard({
	entry,
	actions,
}: {
	entry: AttentionEntry & { kind: "tool" };
	actions: AttentionActions;
}) {
	const { t } = useTranslation("projects");
	const decision = useDecision(actions.teamId, entry.approval, () => actions.onDecided?.(entry));
	return (
		<CardFrame
			entry={entry}
			actions={actions}
			body={
				<>
					<Asker
						entry={entry}
						onOpenSession={actions.onOpenSession}
						onOpenTeam={actions.onOpenTeam}
					/>
					{entry.approval.preview && (
						<Code
							block
							style={{ ...MONO, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 96 }}
							data-testid="team-approval-preview"
						>
							{entry.approval.preview}
						</Code>
					)}
					{decision.note}
				</>
			}
			buttons={
				<>
					<Button
						size="xs"
						variant="default"
						disabled={decision.sent}
						loading={decision.pending && decision.variables?.decision === "deny"}
						onClick={() => decision.send("deny")}
						data-testid="team-approval-deny"
					>
						{t("teams.page.attention.deny")}
					</Button>
					<Button
						size="xs"
						disabled={decision.sent}
						loading={decision.pending && decision.variables?.decision === "allow"}
						onClick={() => decision.send("allow")}
						data-testid="team-approval-approve"
					>
						{t("teams.page.attention.approve")}
					</Button>
				</>
			}
		/>
	);
}

function QuestionCard({
	entry,
	actions,
}: {
	entry: AttentionEntry & { kind: "question" };
	actions: AttentionActions;
}) {
	const { t } = useTranslation("projects");
	const decision = useDecision(actions.teamId, entry.approval, () => actions.onDecided?.(entry));
	const [writing, setWriting] = useState(false);
	const [own, setOwn] = useState("");
	const [formOpen, setFormOpen] = useState(false);
	// One single-choice question read whole by the list: answered right here. Anything else
	// (several questions, several choices, a long input) opens the session's own form.
	const form = entry.approval.answerForm;
	const inline = form && fitsInPlace(form) ? form : null;
	const detail = useApprovalDetail(actions.teamId, entry.approval.id, formOpen);
	const questions = coerceQuestions(detail.data?.permission?.inputJson?.questions);
	const answer = (text: string) => {
		if (!form || !text.trim()) return;
		decision.send("allow", { [form.header]: text.trim() });
	};
	const asked = entry.approval.questions[0] ?? form?.header ?? "";
	// With the form: its title, its whole prompt and each option's explanation, as the session's
	// own form shows them (clamped). Without: the prompt the list read.
	const prompt = inline
		? (inline.description ?? (asked && asked !== inline.header ? asked : null))
		: null;
	const context = inline ? (
		<Stack gap={2} data-testid="team-question-context">
			<Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
				{inline.header}
			</Text>
			{prompt && (
				<Text
					size="sm"
					c="dimmed"
					lineClamp={4}
					title={prompt}
					style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}
					data-testid="team-approval-questions"
				>
					{prompt}
				</Text>
			)}
			{inline.options.map((option, index) =>
				inline.optionDescriptions[index] ? (
					<Text
						// biome-ignore lint/suspicious/noArrayIndexKey: the options of one question, in order
						key={index}
						size="xs"
						c="dimmed"
						lineClamp={2}
						title={inline.optionDescriptions[index] ?? undefined}
						style={{ overflowWrap: "anywhere" }}
						data-testid="team-question-option-description"
					>
						<Text component="span" inherit fw={600}>
							{option}
						</Text>
						{"："}
						{inline.optionDescriptions[index]}
					</Text>
				) : null,
			)}
		</Stack>
	) : null;
	let controls: ReactNode;
	if (inline && !writing)
		controls = (
			<>
				{inline.options.map((option) => (
					<Button
						key={option}
						size="xs"
						variant="default"
						maw={220}
						disabled={decision.sent || decision.pending}
						// The whole title is the answer; only the label is clipped.
						onClick={() => answer(option)}
						title={option}
						data-testid="team-question-option"
						data-value={option}
						styles={{ label: { overflow: "hidden", textOverflow: "ellipsis" } }}
					>
						{option}
					</Button>
				))}
				<Button
					size="xs"
					variant="subtle"
					color="gray"
					disabled={decision.sent}
					onClick={() => setWriting(true)}
					data-testid="team-question-own"
				>
					{t("teams.page.attention.writeOwn")}
				</Button>
			</>
		);
	else if (inline)
		controls = (
			<Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 200 }}>
				<TextInput
					size="xs"
					autoFocus
					value={own}
					onChange={(event) => setOwn(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.nativeEvent.isComposing) answer(own);
					}}
					placeholder={t("teams.page.attention.answerPlaceholder")}
					style={{ flex: 1 }}
					data-testid="team-question-input"
				/>
				<Button
					size="xs"
					disabled={!own.trim() || decision.sent}
					loading={decision.pending}
					onClick={() => answer(own)}
				>
					{t("teams.page.attention.send")}
				</Button>
				<Button size="xs" variant="subtle" color="gray" onClick={() => setWriting(false)}>
					{t("teams.page.attention.cancel")}
				</Button>
			</Group>
		);
	else
		controls = (
			<Button
				size="xs"
				disabled={decision.sent}
				onClick={() => setFormOpen(true)}
				data-testid="team-question-answer"
			>
				{t("teams.page.attention.answer")}
			</Button>
		);
	const unavailable =
		detail.isError || detail.data?.tooLarge || (detail.data && questions.length === 0);
	return (
		<>
			<CardFrame
				entry={entry}
				actions={actions}
				body={
					<>
						<Asker
							entry={entry}
							onOpenSession={actions.onOpenSession}
							onOpenTeam={actions.onOpenTeam}
						/>
						{context ??
							(asked && (
								<Text
									size="sm"
									c="dimmed"
									style={{ overflowWrap: "anywhere" }}
									data-testid="team-approval-questions"
								>
									{asked}
								</Text>
							))}
						{decision.note}
					</>
				}
				buttons={controls}
			/>
			<Modal
				opened={formOpen}
				onClose={() => setFormOpen(false)}
				title={t("teams.page.attention.questionTitle")}
				size="lg"
			>
				{detail.isLoading && <Loader size="sm" />}
				{unavailable && (
					<Stack gap="sm" align="flex-start">
						<Text size="sm" c="dimmed">
							{t(
								detail.data?.tooLarge
									? "teams.page.attention.tooLarge"
									: "teams.page.attention.gone",
							)}
						</Text>
						{actions.onOpenSession && (
							<Button
								size="xs"
								variant="default"
								onClick={() => actions.onOpenSession?.(entry.approval.agent.id)}
								data-testid="team-approval-open"
							>
								{t("teams.page.attention.openSession")}
							</Button>
						)}
					</Stack>
				)}
				{formOpen && !unavailable && questions.length > 0 && (
					<AskUserQuestionBanner
						requestId={entry.approval.id}
						draftId={entry.approval.id}
						questions={questions}
						busy={decision.pending}
						onSubmit={(_id, answers) => {
							setFormOpen(false);
							decision.send("allow", answers);
						}}
					/>
				)}
			</Modal>
		</>
	);
}

function PlanCard({
	entry,
	actions,
}: {
	entry: AttentionEntry & { kind: "plan" };
	actions: AttentionActions;
}) {
	const { t } = useTranslation("projects");
	const decision = useDecision(actions.teamId, entry.approval, () => actions.onDecided?.(entry));
	const [open, setOpen] = useState(false);
	const detail = useApprovalDetail(actions.teamId, entry.approval.id, open);
	const plan = detail.data?.permission?.inputJson?.plan;
	return (
		<>
			<CardFrame
				entry={entry}
				actions={actions}
				body={
					<>
						<Asker
							entry={entry}
							onOpenSession={actions.onOpenSession}
							onOpenTeam={actions.onOpenTeam}
						/>
						{entry.approval.preview && (
							<Text
								size="sm"
								fw={500}
								style={{ overflowWrap: "anywhere" }}
								data-testid="team-plan-title"
							>
								{entry.approval.preview}
							</Text>
						)}
						{decision.note}
					</>
				}
				buttons={
					<>
						<Button
							size="xs"
							variant="default"
							onClick={() => setOpen(true)}
							data-testid="team-plan-view"
						>
							{t("teams.page.attention.viewPlan")}
						</Button>
						<Button
							size="xs"
							disabled={decision.sent}
							loading={decision.pending}
							onClick={() => decision.send("allow")}
							data-testid="team-plan-approve"
						>
							{t("teams.page.attention.approve")}
						</Button>
					</>
				}
			/>
			<Modal
				opened={open}
				onClose={() => setOpen(false)}
				title={t("teams.page.attention.planTitle")}
				size="xl"
			>
				{detail.isLoading ? (
					<Loader size="sm" />
				) : typeof plan === "string" ? (
					<Suspense fallback={<Loader size="sm" />}>
						<MarkdownContent text={plan} />
					</Suspense>
				) : (
					<Text size="sm" c="dimmed">
						{t(
							detail.data?.tooLarge ? "teams.page.attention.tooLarge" : "teams.page.attention.gone",
						)}
					</Text>
				)}
				<Group justify="flex-end" mt="md" gap="xs">
					<Button
						disabled={decision.sent}
						loading={decision.pending}
						onClick={() => {
							setOpen(false);
							decision.send("allow");
						}}
					>
						{t("teams.page.attention.approve")}
					</Button>
				</Group>
			</Modal>
		</>
	);
}

function RuleCard({
	entry,
	actions,
}: {
	entry: AttentionEntry & { kind: "rule" };
	actions: AttentionActions;
}) {
	const { t } = useTranslation("projects");
	return (
		<CardFrame
			entry={entry}
			actions={actions}
			body={
				<Asker
					entry={entry}
					onOpenSession={actions.onOpenSession}
					onOpenTeam={actions.onOpenTeam}
				/>
			}
			buttons={
				<Button
					size="xs"
					variant="default"
					disabled={!actions.onOpenSession}
					onClick={() => actions.onOpenSession?.(entry.approval.agent.id)}
					data-testid="team-approval-open"
				>
					{t("teams.page.attention.openSession")}
				</Button>
			}
		/>
	);
}

function MergeCard({
	entry,
	actions,
}: {
	entry: AttentionEntry & { kind: "merge" };
	actions: AttentionActions;
}) {
	const { t } = useTranslation("projects");
	const { item } = entry;
	const stat = actions.stats?.[item.id];
	const base = item.baseRef ?? entry.base ?? actions.base;
	const mergeTeamId = entry.source?.kind === "team" ? entry.source.teamId : actions.teamId;
	const outcome = item.merge?.phase ? null : (item.merge?.outcome ?? null);
	return (
		<CardFrame
			entry={entry}
			actions={actions}
			body={
				<>
					<Text size="sm" style={{ overflowWrap: "anywhere" }}>
						{entry.source?.kind === "team" && (
							<SourceTeam source={entry.source} onOpenTeam={actions.onOpenTeam} />
						)}
						<Text component="span" inherit fw={700}>
							{item.title}
						</Text>{" "}
						{t("teams.page.attention.mergeable")}{" "}
						<Text component="span" size="xs" c="dimmed" title={item.updatedAt}>
							{formatSmartTime(item.updatedAt)}
						</Text>
					</Text>
					<Group gap={10} wrap="wrap" style={{ rowGap: 4 }}>
						<DiffCount stat={stat} />
						{stat && (
							<Text size="xs" c="dimmed" style={TABULAR}>
								{t("teams.page.attention.files", { count: stat.files })}
							</Text>
						)}
						{item.lastReview === "clear" ? (
							<Badge
								size="sm"
								variant="light"
								color="green"
								tt="none"
								leftSection={<IconCheck size={12} />}
								data-testid="team-merge-verdict"
							>
								{t("teams.page.attention.reviewPassed", { round: Math.max(1, item.reviewRounds) })}
							</Badge>
						) : (
							<Badge size="sm" variant="light" color="gray" tt="none">
								{t("teams.page.attention.notReviewed")}
							</Badge>
						)}
						{item.branch && (
							<Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
								<IconGitBranch size={12} aria-hidden style={{ flexShrink: 0, opacity: 0.6 }} />
								<Text size="xs" c="dimmed" truncate style={MONO}>
									{item.branch} → {base}
								</Text>
							</Group>
						)}
						{outcome && (
							<Badge
								size="sm"
								variant="light"
								color={outcome === "prepared" ? "blue" : "red"}
								tt="none"
								data-testid="team-merge-outcome"
								data-outcome={outcome}
							>
								{t(`teams.page.merge.outcome.${outcome}`, { base })}
							</Badge>
						)}
					</Group>
				</>
			}
			buttons={
				<>
					<Button
						size="xs"
						variant="subtle"
						color="gray"
						onClick={() => actions.onOpenItem(item.id)}
						data-testid="team-merge-view"
					>
						{t("teams.page.attention.viewChanges")}
					</Button>
					<Button
						size="xs"
						variant="default"
						onClick={() => actions.onOpenItem(item.id, { returning: true })}
						data-testid="team-merge-return"
					>
						{t("teams.page.attention.return")}
					</Button>
					{outcome === "prepared" && (
						<Button
							size="xs"
							variant="light"
							onClick={() => actions.onOpenItem(item.id)}
							data-testid="team-merge-open-prepared"
						>
							{t("teams.page.merge.openPrepared")}
						</Button>
					)}
					{actions.projectId && (
						<MergeButton
							projectId={actions.projectId}
							teamId={mergeTeamId}
							itemId={item.id}
							merge={item.merge}
							base={base}
							size="xs"
						/>
					)}
				</>
			}
		/>
	);
}

/** The shared frame of a card: icon, body, buttons; hover highlights its work item. */
function CardFrame({
	entry,
	actions,
	body,
	buttons,
}: {
	entry: AttentionEntry;
	actions: AttentionActions;
	body: ReactNode;
	buttons: ReactNode;
}) {
	const Icon = KIND_ICON[entry.kind];
	const itemId = entry.item?.id ?? null;
	return (
		<Group
			className="nf-attention-card"
			gap="sm"
			wrap="nowrap"
			align="flex-start"
			px="md"
			py={10}
			onMouseEnter={() => actions.onHover?.(itemId)}
			onMouseLeave={() => actions.onHover?.(null)}
			data-testid="team-attention-card"
			data-kind={entry.kind}
			data-item-id={itemId ?? undefined}
			data-request-id={entry.kind === "merge" ? undefined : entry.approval.id}
		>
			<ThemeIcon
				size={30}
				radius="md"
				variant="light"
				color="yellow"
				style={{ flexShrink: 0, color: ATTENTION_TEXT }}
			>
				<Icon size={16} aria-hidden />
			</ThemeIcon>
			<Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
				{body}
			</Stack>
			<Group
				className="nf-attention-buttons"
				gap={6}
				wrap="wrap"
				justify="flex-end"
				style={{ flexShrink: 0, maxWidth: "55%" }}
			>
				{buttons}
			</Group>
		</Group>
	);
}

function AttentionCard({ entry, actions }: { entry: AttentionEntry; actions: AttentionActions }) {
	switch (entry.kind) {
		case "tool":
			return <ToolCard entry={entry} actions={actions} />;
		case "question":
			return <QuestionCard entry={entry} actions={actions} />;
		case "plan":
			return <PlanCard entry={entry} actions={actions} />;
		case "rule":
			return <RuleCard entry={entry} actions={actions} />;
		case "merge":
			return <MergeCard entry={entry} actions={actions} />;
	}
}

/** Phone: the card frame stacks (body above, buttons below, full width). */
const PHONE_CSS = `
[data-attention-layout="phone"] .nf-attention-card { flex-direction: column; align-items: stretch; height: 100%; }
[data-attention-layout="phone"] .nf-attention-card > .mantine-ThemeIcon-root { display: none; }
[data-attention-layout="phone"] .nf-attention-buttons { max-width: none !important; justify-content: stretch; margin-top: auto; }
[data-attention-layout="phone"] .nf-attention-buttons > * { flex: 1; }
`;

export function TeamAttention({
	entries,
	phone,
	more: moreCalls = false,
	unscanned = false,
	onOpenCoordinatorSession,
	flush = false,
	inPage = false,
	beyondKeys,
	...actions
}: AttentionActions & {
	/**
	 * The block flows with its page (the project page): no inner scroll on a desktop, where the
	 * fold to 「还有 N 条」 keeps it short.
	 */
	inPage?: boolean;
	/** The wording of the "more than listed" line (default: open the coordinator's session). */
	beyondKeys?: { more: string; unscanned: string };
	entries: AttentionEntry[];
	phone: boolean;
	/** No outer padding: the host page lays the block out (the project page). */
	flush?: boolean;
	/** More calls wait than the list holds (50). */
	more?: boolean;
	/** The scan stopped before reading every pending call. */
	unscanned?: boolean;
	onOpenCoordinatorSession?: () => void;
}) {
	const { t } = useTranslation("projects");
	const [expanded, setExpanded] = useState(false);
	const [position, setPosition] = useState(0);
	const scroller = useRef<HTMLDivElement | null>(null);
	if (entries.length === 0) return null;
	const { shown, hidden } = attentionView(entries, expanded);
	// The list holds at most 50 calls; past it (or when the scan stopped early) say so.
	const beyond =
		moreCalls || unscanned ? (
			<Group gap="xs" wrap="nowrap" justify="space-between" data-testid="team-attention-beyond">
				<Text size="xs" c="dimmed">
					{t(
						moreCalls
							? (beyondKeys?.more ?? "teams.page.attention.moreInSession")
							: (beyondKeys?.unscanned ?? "teams.page.attention.unscanned"),
					)}
				</Text>
				{onOpenCoordinatorSession && (
					<Button size="compact-xs" variant="subtle" onClick={onOpenCoordinatorSession}>
						{t("teams.page.attention.openFull")}
					</Button>
				)}
			</Group>
		) : null;
	const header = (
		<Group gap={8} wrap="nowrap" justify="space-between">
			<Group gap={8} wrap="nowrap">
				<Text size="sm" fw={700} style={{ color: ATTENTION_TEXT }}>
					{t("teams.page.attention.title")}
				</Text>
				<Badge
					size="sm"
					circle
					variant="filled"
					style={{ background: ATTENTION_COLOR, color: "var(--mantine-color-dark-9)", ...TABULAR }}
					data-testid="team-attention-count"
				>
					{moreCalls ? `${entries.length}+` : entries.length}
				</Badge>
				{phone && (
					<Text size="xs" c="dimmed">
						{t("teams.page.attention.swipe")}
					</Text>
				)}
			</Group>
			{phone && (
				<Text size="xs" c="dimmed" style={TABULAR}>
					{t("teams.page.attention.position", {
						index: Math.min(position + 1, shown.length),
						total: entries.length,
					})}
				</Text>
			)}
		</Group>
	);
	const more =
		hidden > 0 || (expanded && entries.length > 3) ? (
			<UnstyledButton
				onClick={() => setExpanded((value) => !value)}
				data-testid="team-attention-more"
				style={{ color: ATTENTION_TEXT, fontSize: "var(--mantine-font-size-sm)", ...TABULAR }}
			>
				<Group gap={4} wrap="nowrap">
					<IconChevronDown
						size={14}
						aria-hidden
						style={{ transform: expanded ? "rotate(180deg)" : undefined }}
					/>
					{expanded
						? t("teams.page.attention.less")
						: t("teams.page.attention.more", { count: hidden })}
				</Group>
			</UnstyledButton>
		) : null;

	if (phone)
		return (
			<Box
				px={flush ? 0 : "sm"}
				pt={flush ? 0 : "sm"}
				data-testid="team-attention"
				data-attention-layout="phone"
			>
				<style>{PHONE_CSS}</style>
				<Stack gap={8}>
					{header}
					<ScrollArea
						type="never"
						viewportRef={scroller}
						onScrollPositionChange={({ x }) => {
							const width = scroller.current?.clientWidth ?? 1;
							setPosition(Math.round(x / Math.max(1, width * 0.86)));
						}}
						styles={{ viewport: { scrollSnapType: "x mandatory" } }}
					>
						<Group gap={10} wrap="nowrap" align="stretch" pb={2}>
							{shown.map((entry) => (
								<Box
									key={entry.id}
									style={{
										flex: "0 0 86%",
										scrollSnapAlign: "start",
										background: ATTENTION_BG,
										border: `1px solid ${ATTENTION_BORDER}`,
										borderRadius: "var(--mantine-radius-md)",
									}}
								>
									<AttentionCard entry={entry} actions={actions} />
								</Box>
							))}
							{hidden > 0 && (
								<Box
									style={{
										flex: "0 0 40%",
										scrollSnapAlign: "start",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										border: `1px dashed ${ATTENTION_BORDER}`,
										borderRadius: "var(--mantine-radius-md)",
									}}
								>
									{more}
								</Box>
							)}
						</Group>
					</ScrollArea>
					{shown.length > 1 && (
						<Group gap={5} justify="center" aria-hidden>
							{shown.map((entry, index) => (
								<Box
									key={entry.id}
									style={{
										width: 6,
										height: 6,
										borderRadius: "50%",
										background:
											index === position ? ATTENTION_COLOR : "var(--mantine-color-default-border)",
									}}
								/>
							))}
						</Group>
					)}
					{beyond}
				</Stack>
			</Box>
		);

	const cards = shown.map((entry, index) => (
		<Box
			key={entry.id}
			style={index > 0 ? { borderTop: `1px solid ${ATTENTION_BORDER}` } : undefined}
		>
			<AttentionCard entry={entry} actions={actions} />
		</Box>
	));
	return (
		<Box
			px={flush ? 0 : "md"}
			pt={flush ? 0 : "md"}
			data-testid="team-attention"
			data-attention-layout="desktop"
		>
			<Box
				style={{
					background: ATTENTION_BG,
					border: `1px solid ${ATTENTION_BORDER}`,
					borderRadius: "var(--mantine-radius-md)",
					overflow: "hidden",
				}}
			>
				<Box px="md" py={8} style={{ borderBottom: `1px solid ${ATTENTION_BORDER}` }}>
					{header}
				</Box>
				{inPage ? (
					cards
				) : (
					<ScrollArea.Autosize mah="40vh" type="auto">
						{cards}
					</ScrollArea.Autosize>
				)}
				{more && (
					<Box px="md" py={6} style={{ borderTop: `1px solid ${ATTENTION_BORDER}` }}>
						{more}
					</Box>
				)}
				{beyond && (
					<Box px="md" py={6} style={{ borderTop: `1px solid ${ATTENTION_BORDER}` }}>
						{beyond}
					</Box>
				)}
			</Box>
		</Box>
	);
}
