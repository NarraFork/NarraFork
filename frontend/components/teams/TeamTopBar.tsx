/**
 * The team page's top bar (docs/PROJECT_TEAMS-PLAN.md §二.11, §二.12; P4, M1): the pending
 * approvals of the whole tree (members only; any member decides through the ordinary permission
 * routes, and the latest decisions say who took them), the team's people (members and onlookers;
 * the owner manages access there), the running sessions, and "pause all" (stops every running
 * session's turn, coordinator first).
 */
import { NarratorStatusIcon } from "@frontend/components/nav/NarratorStatusIcon";
import { useDecideApproval, usePauseTeam, useTeamApprovals } from "@frontend/hooks/useTeams";
import { formatSmartTime } from "@frontend/lib/format";
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Code,
	Drawer,
	Group,
	Loader,
	Modal,
	Popover,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	TEAM_APPROVALS_LIMIT,
	TEAM_RUNNING_AGENTS_LIMIT,
	type TeamPageSummary,
	type TeamPendingApproval,
	type TeamRecentDecision,
} from "@shared/project-teams";
import {
	IconCheck,
	IconClockPause,
	IconEyeOff,
	IconMessageCircle,
	IconMessageOff,
	IconMessagePlus,
	IconPlayerPause,
	IconShieldQuestion,
	IconSparkles,
	IconUsers,
	IconX,
} from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { TeamMembersPanel } from "./TeamMembers";
import {
	cappedCount,
	pauseNotice,
	type RecentDecisionKey,
	recentDecisionKey,
	recentDecisionTextKey,
} from "./team-page-model";

const DEPTH_ROLE = ["coordinator", "worker", "helper"] as const;

function ApprovalRow({
	approval,
	teamId,
	onOpenSession,
}: {
	approval: TeamPendingApproval;
	teamId: string;
	onOpenSession?: (narratorId: string) => void;
}) {
	const { t } = useTranslation("projects");
	const decide = useDecideApproval(teamId);
	const [sent, setSent] = useState<"allow" | "deny" | null>(null);
	const send = (decision: "allow" | "deny") =>
		decide.mutate(
			{ requestId: approval.id, decision },
			{
				onSuccess: () => {
					setSent(decision);
					notifications.show({ color: "green", message: t("teams.approvals.decided") });
				},
				onError: () => notifications.show({ color: "red", message: t("teams.approvals.failed") }),
			},
		);
	const role = DEPTH_ROLE[Math.min(approval.depth, 2)];
	return (
		<Stack
			gap={6}
			p="xs"
			style={{
				border: "1px solid var(--mantine-color-default-border)",
				borderRadius: "var(--mantine-radius-sm)",
			}}
			data-testid="team-approval"
			data-request-id={approval.id}
		>
			<Group gap={6} wrap="nowrap" justify="space-between">
				<UnstyledButton
					onClick={() => onOpenSession?.(approval.agent.id)}
					disabled={!onOpenSession}
					aria-label={t("teams.approvals.openSession")}
					style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}
				>
					<NarratorStatusIcon size={14} status={approval.agent.status} />
					<Text size="sm" fw={500} truncate>
						{approval.agent.title || approval.agent.id}
					</Text>
				</UnstyledButton>
				<Badge size="xs" variant="light" color="gray" tt="none" style={{ flexShrink: 0 }}>
					{t(`teams.approvals.${role}`)}
				</Badge>
			</Group>
			<Group gap={6} wrap="nowrap" justify="space-between">
				<Text size="xs" fw={600}>
					{approval.kind === "tool"
						? approval.toolName
						: t(`teams.approvals.kinds.${approval.kind}`)}
				</Text>
				<Text size="xs" c="dimmed" title={approval.createdAt}>
					{formatSmartTime(approval.createdAt)}
				</Text>
			</Group>
			{approval.preview && (
				<Code
					block
					style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 120 }}
					data-testid="team-approval-preview"
				>
					{approval.preview}
				</Code>
			)}
			{approval.questions.length > 0 && (
				<Stack gap={2} data-testid="team-approval-questions">
					{approval.questions.map((question, index) => (
						<Text
							// biome-ignore lint/suspicious/noArrayIndexKey: the questions of one call, in order
							key={index}
							size="sm"
							style={{ overflowWrap: "anywhere" }}
						>
							{question}
						</Text>
					))}
				</Stack>
			)}
			{approval.decisionReason && approval.kind === "tool" && (
				<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
					{approval.decisionReason}
				</Text>
			)}
			{approval.kind === "tool" ? (
				<Group gap="xs" justify="flex-end">
					<Button
						size="xs"
						variant="default"
						disabled={sent !== null}
						loading={decide.isPending && decide.variables?.decision === "deny"}
						onClick={() => send("deny")}
						data-testid="team-approval-deny"
					>
						{t("teams.approvals.deny")}
					</Button>
					<Button
						size="xs"
						disabled={sent !== null}
						loading={decide.isPending && decide.variables?.decision === "allow"}
						onClick={() => send("allow")}
						data-testid="team-approval-approve"
					>
						{t("teams.approvals.approve")}
					</Button>
				</Group>
			) : (
				// A question needs its answers, a plan or rule request its own choices: answered
				// in the session, never with a bare approve here.
				<Group gap="xs" justify="space-between" wrap="nowrap">
					<Text size="xs" c="dimmed">
						{t("teams.approvals.answerInSession")}
					</Text>
					<Button
						size="xs"
						variant="light"
						disabled={!onOpenSession}
						onClick={() => onOpenSession?.(approval.agent.id)}
						data-testid="team-approval-open"
						style={{ flexShrink: 0 }}
					>
						{t("teams.approvals.openSession")}
					</Button>
				</Group>
			)}
		</Stack>
	);
}

const DECISION_ICON = {
	allowed: IconCheck,
	denied: IconX,
	answered: IconMessageCircle,
	dismissed: IconMessageOff,
	ignored: IconEyeOff,
	supplemented: IconMessagePlus,
	deferred: IconClockPause,
	answeredByAi: IconSparkles,
} as const satisfies Record<RecentDecisionKey, unknown>;
const DECISION_COLOR = {
	allowed: "green",
	denied: "red",
	answered: "indigo",
	dismissed: "gray",
	ignored: "gray",
	supplemented: "indigo",
	deferred: "gray",
	answeredByAi: "violet",
} as const satisfies Record<RecentDecisionKey, string>;

/** One decision a person took on a call of the tree: who, what, where, when. */
export function RecentDecisionRow({ decision }: { decision: TeamRecentDecision }) {
	const { t } = useTranslation("projects");
	const key = recentDecisionKey(decision.kind);
	const Icon = DECISION_ICON[key];
	const role = DEPTH_ROLE[Math.min(Math.max(decision.depth, 0), 2)];
	const who = decision.actorName ?? t("teams.activity.unknownPerson");
	const what = decision.toolName;
	return (
		<Group
			gap="xs"
			wrap="nowrap"
			align="flex-start"
			data-testid="team-recent-decision"
			data-kind={decision.kind}
		>
			<Icon
				size={16}
				aria-label={t(`teams.approvals.recent.${key}Label`)}
				color={`var(--mantine-color-${DECISION_COLOR[key]}-6)`}
				style={{ flexShrink: 0, marginTop: 2 }}
			/>
			<Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
				<Text size="sm" style={{ overflowWrap: "anywhere" }}>
					{t(
						`teams.approvals.recent.${recentDecisionTextKey(decision.kind, decision.approvalKind)}`,
						{
							who,
							what,
						},
					)}
				</Text>
				<Text size="xs" c="dimmed" truncate>
					{decision.depth === 0
						? t("teams.approvals.coordinator")
						: `${decision.agentTitle ?? t("teams.activity.unknownAgent")} · ${t(`teams.approvals.${role}`)}`}
				</Text>
			</Stack>
			<Text size="xs" c="dimmed" title={decision.createdAt} style={{ flexShrink: 0 }}>
				{formatSmartTime(decision.createdAt)}
			</Text>
		</Group>
	);
}

export function TeamApprovalsList({
	projectId,
	teamId,
	onOpenSession,
}: {
	projectId: string;
	teamId: string;
	onOpenSession?: (narratorId: string) => void;
}) {
	const { t } = useTranslation("projects");
	const approvals = useTeamApprovals(projectId, teamId, true);
	const recent = approvals.data?.recent ?? [];
	return (
		<Stack gap="xs" data-testid="team-approvals">
			{approvals.isLoading && <Loader size="sm" />}
			{approvals.isError && <Alert color="red">{t("teams.approvals.loadFailed")}</Alert>}
			{approvals.data?.approvals.length === 0 && (
				<Text size="sm" c="dimmed" data-testid="team-approvals-empty">
					{t("teams.approvals.empty")}
				</Text>
			)}
			{approvals.data?.approvals.map((approval) => (
				<ApprovalRow
					key={approval.id}
					approval={approval}
					teamId={teamId}
					onOpenSession={onOpenSession}
				/>
			))}
			{approvals.data?.more && (
				<Text size="xs" c="dimmed">
					{t("teams.approvals.more", { count: TEAM_APPROVALS_LIMIT })}
				</Text>
			)}
			{approvals.data?.unscanned && (
				<Text size="xs" c="dimmed" data-testid="team-approvals-unscanned">
					{t("teams.approvals.unscanned")}
				</Text>
			)}
			{recent.length > 0 && (
				<Stack gap={6} mt="sm" data-testid="team-recent-decisions">
					<Text size="xs" fw={600}>
						{t("teams.approvals.recentTitle")}
					</Text>
					{recent.map((decision) => (
						<RecentDecisionRow key={decision.id} decision={decision} />
					))}
				</Stack>
			)}
		</Stack>
	);
}

export function TeamTopBar({
	projectId,
	teamId,
	title,
	summary,
	leading,
	onOpenSession,
}: {
	projectId: string;
	teamId: string;
	title: ReactNode;
	summary: TeamPageSummary | undefined;
	/** Before the title (a back link on narrow screens). */
	leading?: ReactNode;
	onOpenSession?: (narratorId: string) => void;
}) {
	const { t } = useTranslation("projects");
	const [approvalsOpen, setApprovalsOpen] = useState(false);
	const [membersOpen, setMembersOpen] = useState(false);
	const [confirmPause, setConfirmPause] = useState(false);
	const pause = usePauseTeam(projectId, teamId);
	const member = summary?.access === "write";
	const pending = summary?.pendingApprovalCount ?? 0;
	const running = summary?.runningCount ?? 0;
	const pauseAll = () => {
		pause.mutate(undefined, {
			onSuccess: (outcome) => {
				setConfirmPause(false);
				const notice = pauseNotice(outcome);
				notifications.show({
					color: notice.color,
					message: t(`teams.top.${notice.key}`, {
						count: outcome.stopped,
						stopped: outcome.stopped,
						failed: outcome.failed,
						idle: outcome.alreadyIdle,
					}),
				});
			},
			onError: () => notifications.show({ color: "red", message: t("teams.top.pauseError") }),
		});
	};
	return (
		<Group
			gap="xs"
			justify="space-between"
			wrap="wrap"
			px="sm"
			py={6}
			data-testid="team-top-bar"
			style={{ borderBottom: "1px solid var(--mantine-color-default-border)", rowGap: 6 }}
		>
			<Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: "1 1 160px" }}>
				{leading}
				{summary && <NarratorStatusIcon size={16} status={summary.coordinatorStatus} />}
				<Text fw={600} truncate data-testid="team-title">
					{title}
				</Text>
			</Group>
			<Group gap={6} wrap="wrap" justify="flex-end" style={{ rowGap: 6 }}>
				{member && (
					<Button
						size="xs"
						variant={pending > 0 ? "filled" : "light"}
						color={pending > 0 ? "orange" : "gray"}
						leftSection={<IconShieldQuestion size={14} aria-hidden />}
						onClick={() => setApprovalsOpen(true)}
						data-testid="team-approvals-button"
						data-count={pending}
					>
						{t("teams.top.approvals", {
							count: pending,
							shown: cappedCount(pending, TEAM_APPROVALS_LIMIT),
						})}
					</Button>
				)}
				{summary && (
					// Icon-only: the bar must still fit beside the other controls at 360 px.
					<Tooltip label={t("teams.top.members")} withinPortal>
						<ActionIcon
							size={30}
							variant="light"
							color="gray"
							aria-label={t("teams.top.members")}
							onClick={() => setMembersOpen(true)}
							data-testid="team-members-button"
						>
							<IconUsers size={16} aria-hidden />
						</ActionIcon>
					</Tooltip>
				)}
				<Popover position="bottom-end" shadow="md" withinPortal>
					<Popover.Target>
						<Button
							size="xs"
							variant="light"
							color={running > 0 ? "blue" : "gray"}
							data-testid="team-running-button"
							data-count={running}
						>
							{running > 0
								? t("teams.top.running", {
										count: running,
										shown: cappedCount(running, TEAM_RUNNING_AGENTS_LIMIT),
									})
								: t("teams.top.noneRunning")}
						</Button>
					</Popover.Target>
					<Popover.Dropdown maw="min(320px, calc(100vw - 32px))">
						<Stack gap={6} data-testid="team-running-list">
							<Text size="xs" fw={600}>
								{t("teams.agents.title")}
							</Text>
							{summary?.runningAgents.length ? (
								summary.runningAgents.map((agent) => (
									<UnstyledButton
										key={agent.id}
										onClick={() => onOpenSession?.(agent.id)}
										style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}
									>
										<NarratorStatusIcon size={14} status={agent.status} />
										<Text size="sm" truncate>
											{agent.title || agent.id}
										</Text>
									</UnstyledButton>
								))
							) : (
								<Text size="xs" c="dimmed">
									{t("teams.top.noneRunning")}
								</Text>
							)}
						</Stack>
					</Popover.Dropdown>
				</Popover>
				{member && (
					<Button
						size="xs"
						variant="light"
						color="red"
						leftSection={<IconPlayerPause size={14} aria-hidden />}
						onClick={() => setConfirmPause(true)}
						data-testid="team-pause-all"
					>
						{t("teams.top.pauseAll")}
					</Button>
				)}
			</Group>
			<Drawer
				opened={approvalsOpen}
				onClose={() => setApprovalsOpen(false)}
				position="right"
				size="min(440px, 100%)"
				title={t("teams.approvals.title")}
			>
				{approvalsOpen && member && (
					<TeamApprovalsList
						projectId={projectId}
						teamId={teamId}
						onOpenSession={
							onOpenSession &&
							((narratorId) => {
								setApprovalsOpen(false);
								onOpenSession(narratorId);
							})
						}
					/>
				)}
			</Drawer>
			<Drawer
				opened={membersOpen}
				onClose={() => setMembersOpen(false)}
				position="right"
				size="min(440px, 100%)"
				title={t("teams.members.title")}
			>
				{membersOpen && <TeamMembersPanel projectId={projectId} teamId={teamId} />}
			</Drawer>
			<Modal
				opened={confirmPause}
				onClose={() => setConfirmPause(false)}
				title={t("teams.top.pauseConfirmTitle")}
				size="sm"
			>
				<Stack>
					<Text size="sm">{t("teams.top.pauseConfirm")}</Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="default" onClick={() => setConfirmPause(false)}>
							{t("teams.create.cancel")}
						</Button>
						<Button
							color="red"
							loading={pause.isPending}
							onClick={pauseAll}
							data-testid="team-pause-confirm"
						>
							{t("teams.top.pauseConfirmButton")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Group>
	);
}
