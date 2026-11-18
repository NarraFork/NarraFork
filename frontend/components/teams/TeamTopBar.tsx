/**
 * The team page's top bar (docs/PROJECT_TEAMS-PLAN.md §二.11, §二.12; P4): the pending approvals
 * of the whole tree (members only; any member decides through the ordinary permission routes),
 * the running sessions, and "pause all" (stops every running session's turn, coordinator first).
 */
import { NarratorStatusIcon } from "@frontend/components/nav/NarratorStatusIcon";
import { useDecideApproval, usePauseTeam, useTeamApprovals } from "@frontend/hooks/useTeams";
import { formatSmartTime } from "@frontend/lib/format";
import {
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
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	TEAM_APPROVALS_LIMIT,
	TEAM_RUNNING_AGENTS_LIMIT,
	type TeamPageSummary,
	type TeamPendingApproval,
} from "@shared/project-teams";
import { IconPlayerPause, IconShieldQuestion } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { cappedCount, pauseNotice } from "./team-page-model";

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
			<Group gap={6} wrap="nowrap">
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
					<TeamApprovalsList projectId={projectId} teamId={teamId} onOpenSession={onOpenSession} />
				)}
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
