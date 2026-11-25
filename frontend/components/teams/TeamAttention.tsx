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
 *   - a ready item: +/-, files, the review verdict, branch → base, 查看改动 / 退回 / 合并. The
 *     server never merges, so 合并 is shown disabled and says how the item becomes merged.
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
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import type { TeamPendingApproval, TeamWorkDiffStat } from "@shared/project-teams";
import {
	IconCheck,
	IconChevronDown,
	IconGitBranch,
	IconGitMerge,
	IconHelpCircle,
	IconListCheck,
	IconShieldQuestion,
	IconTerminal2,
} from "@tabler/icons-react";
import { lazy, type ReactNode, Suspense, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskUserQuestionBanner, coerceQuestions } from "../narrator/question/AskUserQuestionBanner";
import { type AttentionEntry, attentionView } from "./team-page-model";
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

/** Options a question card shows inline before its full form is needed. */
const INLINE_OPTIONS = 4;

export interface AttentionActions {
	teamId: string;
	/** The base the team's branches merge into (for the merge card). */
	base: string;
	stats: Record<string, TeamWorkDiffStat | null> | undefined;
	onHover?: (itemId: string | null) => void;
	onOpenItem: (itemId: string, options?: { returning?: boolean }) => void;
	onOpenSession?: (narratorId: string) => void;
}

const KIND_ICON = {
	tool: IconTerminal2,
	question: IconHelpCircle,
	plan: IconListCheck,
	rule: IconShieldQuestion,
	merge: IconGitBranch,
} as const;

/** Who asks: the work item's title (its worker asks), or the coordinator, or the session. */
function Asker({ entry }: { entry: Exclude<AttentionEntry, { kind: "merge" }> }) {
	const { t } = useTranslation("projects");
	const coordinator = entry.approval.depth === 0;
	const who = coordinator
		? t("teams.page.attention.coordinator")
		: (entry.item?.title ?? entry.approval.agent.title ?? entry.approval.agent.id);
	const verb = {
		tool: coordinator ? "coordinatorAsksTool" : "asksTool",
		question: coordinator ? "coordinatorAsksQuestion" : "asksQuestion",
		plan: coordinator ? "coordinatorAsksPlan" : "asksPlan",
		rule: coordinator ? "coordinatorAsksRule" : "asksRule",
	}[entry.kind];
	return (
		<Text size="sm" style={{ overflowWrap: "anywhere" }}>
			<Text component="span" inherit fw={700}>
				{who}
			</Text>{" "}
			{t(`teams.page.attention.${verb}`, { tool: entry.approval.toolName })}{" "}
			<Text component="span" size="xs" c="dimmed" title={entry.approval.createdAt}>
				{formatSmartTime(entry.approval.createdAt)}
			</Text>
		</Text>
	);
}

function useDecision(teamId: string, approval: TeamPendingApproval) {
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
	const decision = useDecision(actions.teamId, entry.approval);
	return (
		<CardFrame
			entry={entry}
			actions={actions}
			body={
				<>
					<Asker entry={entry} />
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
	const decision = useDecision(actions.teamId, entry.approval);
	const [writing, setWriting] = useState(false);
	const [own, setOwn] = useState("");
	const [formOpen, setFormOpen] = useState(false);
	// One single-choice question read whole by the list: answered right here. Anything else
	// (several questions, several choices, a long input) opens the session's own form.
	const form = entry.approval.answerForm;
	const inline = form && !form.multiSelect && form.options.length <= INLINE_OPTIONS ? form : null;
	const detail = useApprovalDetail(actions.teamId, entry.approval.id, formOpen);
	const questions = coerceQuestions(detail.data?.permission?.inputJson?.questions);
	const answer = (text: string) => {
		if (!form || !text.trim()) return;
		decision.send("allow", { [form.header]: text.trim() });
	};
	const asked = entry.approval.questions[0] ?? form?.header ?? "";
	let controls: ReactNode;
	if (inline && !writing)
		controls = (
			<>
				{inline.options.map((option) => (
					<Button
						key={option}
						size="xs"
						variant="default"
						disabled={decision.sent || decision.pending}
						onClick={() => answer(option)}
						data-testid="team-question-option"
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
						<Asker entry={entry} />
						{asked && (
							<Text
								size="sm"
								c="dimmed"
								style={{ overflowWrap: "anywhere" }}
								data-testid="team-approval-questions"
							>
								{asked}
							</Text>
						)}
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
	const decision = useDecision(actions.teamId, entry.approval);
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
						<Asker entry={entry} />
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
			body={<Asker entry={entry} />}
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
	const base = item.baseRef ?? actions.base;
	return (
		<CardFrame
			entry={entry}
			actions={actions}
			body={
				<>
					<Text size="sm" style={{ overflowWrap: "anywhere" }}>
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
					<Tooltip
						label={t("teams.page.attention.mergeDisabled", { base })}
						withinPortal
						multiline
						maw={300}
					>
						<span>
							<Button
								size="xs"
								disabled
								leftSection={<IconGitMerge size={14} aria-hidden />}
								data-testid="team-merge"
							>
								{t("teams.page.attention.merge")}
							</Button>
						</span>
					</Tooltip>
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
	...actions
}: AttentionActions & { entries: AttentionEntry[]; phone: boolean }) {
	const { t } = useTranslation("projects");
	const [expanded, setExpanded] = useState(false);
	const [position, setPosition] = useState(0);
	const scroller = useRef<HTMLDivElement | null>(null);
	if (entries.length === 0) return null;
	const { shown, hidden } = attentionView(entries, expanded);
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
					{entries.length}
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
			<Box px="sm" pt="sm" data-testid="team-attention" data-attention-layout="phone">
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
				</Stack>
			</Box>
		);

	return (
		<Box px="md" pt="md" data-testid="team-attention" data-attention-layout="desktop">
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
				<ScrollArea.Autosize mah="40vh" type="auto">
					{shown.map((entry, index) => (
						<Box
							key={entry.id}
							style={index > 0 ? { borderTop: `1px solid ${ATTENTION_BORDER}` } : undefined}
						>
							<AttentionCard entry={entry} actions={actions} />
						</Box>
					))}
				</ScrollArea.Autosize>
				{more && (
					<Box px="md" py={6} style={{ borderTop: `1px solid ${ATTENTION_BORDER}` }}>
						{more}
					</Box>
				)}
			</Box>
		</Box>
	);
}
