/**
 * The team page's header (the redesign R): one row with the project crumb, the team's name and
 * one status sentence on the left (「3 项进行中 · 1 项等你」, 「空闲」, 「已暂停」, 「已归档」), and on
 * the right the people (at most three avatars, then +N; they open the members drawer), "pin to
 * sidebar", 「全部暂停」 (a plain button: it stops every running session of the tree, coordinator
 * first) and the 「…」 menu (team settings, the coordinator's full session, disband).
 *
 * On a phone the header takes two rows (name and actions, then the sentence and the people), its
 * own menu button stands first (so the shell's floating one never covers it), and 「全部暂停」
 * moves into the 「…」 menu.
 */
import { MobileNavButton } from "@frontend/components/nav/MobileNavButton";
import { PinToSidebarButton } from "@frontend/components/nav/PinToSidebarButton";
import { usePauseTeam, useTeamMembers } from "@frontend/hooks/useTeams";
import {
	ActionIcon,
	Avatar,
	Badge,
	Box,
	Button,
	Drawer,
	Group,
	Menu,
	Modal,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { TeamPageSummary } from "@shared/project-teams";
import {
	IconArrowLeft,
	IconDots,
	IconExternalLink,
	IconPlayerPause,
	IconSettings,
	IconUsers,
	IconUsersGroup,
	IconUsersMinus,
} from "@tabler/icons-react";
import { Fragment, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "../UserAvatar";
import { TeamMembersPanel } from "./TeamMembers";
import { pauseNotice, type StatusPart, type StatusTone } from "./team-page-model";
import { ATTENTION_TEXT, StatusDot, statusTone, TABULAR } from "./team-page-ui";

/** Avatars shown before +N. */
const AVATARS_SHOWN = 3;

function StatusSentence({ tone, parts }: { tone: StatusTone; parts: StatusPart[] }) {
	const { t } = useTranslation("projects");
	return (
		<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }} data-testid="team-status" data-tone={tone}>
			<StatusDot tone={statusTone(tone)} />
			<Text size="sm" c="dimmed" truncate style={TABULAR}>
				{parts.map((part, index) => (
					<Fragment key={part.key}>
						{index > 0 && " · "}
						<Text
							component="span"
							inherit
							fw={part.key === "waitingYou" ? 600 : undefined}
							style={part.key === "waitingYou" ? { color: ATTENTION_TEXT } : undefined}
							data-part={part.key}
						>
							{t(`teams.page.status.${part.key}`, { count: part.count ?? 0 })}
						</Text>
					</Fragment>
				))}
			</Text>
		</Group>
	);
}

function MemberAvatars({
	projectId,
	teamId,
	onOpen,
}: {
	projectId: string;
	teamId: string;
	onOpen: () => void;
}) {
	const { t } = useTranslation("projects");
	const members = useTeamMembers(projectId, teamId, true);
	const people = members.data?.members ?? [];
	const shown = people.slice(0, AVATARS_SHOWN);
	const extra = people.length - shown.length + (members.data?.more ? 1 : 0);
	return (
		<Tooltip label={t("teams.page.header.members")} withinPortal>
			<UnstyledButton
				onClick={onOpen}
				aria-label={t("teams.page.header.members")}
				data-testid="team-members-button"
				style={{ display: "inline-flex", flexShrink: 0 }}
			>
				{shown.length === 0 ? (
					<ActionIcon component="span" size={28} variant="subtle" color="gray">
						<IconUsers size={16} aria-hidden />
					</ActionIcon>
				) : (
					<Avatar.Group spacing={8}>
						{shown.map((member) => (
							<UserAvatar
								key={member.userId}
								username={member.username}
								avatarColor={member.avatarColor}
								avatarImageId={member.avatarImageId}
								userId={member.userId}
								size={26}
								showTooltip={false}
							/>
						))}
						{extra > 0 && (
							<Avatar size={26} style={TABULAR}>
								{t("teams.page.header.moreMembers", { count: extra })}
							</Avatar>
						)}
					</Avatar.Group>
				)}
			</UnstyledButton>
		</Tooltip>
	);
}

export function TeamHeader({
	projectId,
	teamId,
	projectName,
	title,
	pinTitle,
	summary,
	status,
	phone,
	onBack,
	onOpenCoordinatorSession,
	onOpenSettings,
	onDisband,
}: {
	projectId: string;
	teamId: string;
	projectName: string | null;
	title: ReactNode;
	/** The team's name when it may be pinned (active): shows "pin to sidebar". */
	pinTitle?: string;
	summary: TeamPageSummary | undefined;
	status: { tone: StatusTone; parts: StatusPart[] } | null;
	phone: boolean;
	onBack: () => void;
	onOpenCoordinatorSession?: () => void;
	onOpenSettings?: () => void;
	/** Members get 解散团队 in the menu (the server decides whether they may). */
	onDisband?: () => void;
}) {
	const { t } = useTranslation("projects");
	const [membersOpen, setMembersOpen] = useState(false);
	const [confirmPause, setConfirmPause] = useState(false);
	const pause = usePauseTeam(projectId, teamId);
	const member = summary?.access === "write";
	const archived = summary?.coordinatorStatus === "archived";
	const running = summary?.runningCount ?? 0;
	// An archived coordinator does not stop the workers it started: pause stays while any runs.
	const canPause = member && (!archived || running > 0);
	const canEdit = member && !archived;
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

	const back = (
		<ActionIcon
			variant="subtle"
			color="gray"
			size={28}
			aria-label={t("teams.page.back")}
			onClick={onBack}
			data-testid="team-back"
		>
			<IconArrowLeft size={16} />
		</ActionIcon>
	);
	const name = (
		<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
			<IconUsersGroup size={16} aria-hidden style={{ flexShrink: 0, opacity: 0.7 }} />
			<Text fw={700} size={phone ? "lg" : "md"} truncate data-testid="team-title">
				{title}
			</Text>
			{archived && (
				<Tooltip label={t("teams.top.archivedHint")} withinPortal multiline maw={280}>
					<Badge
						size="sm"
						variant="light"
						color="gray"
						tt="none"
						style={{ flexShrink: 0 }}
						data-testid="team-archived"
					>
						{t("teams.archived")}
					</Badge>
				</Tooltip>
			)}
		</Group>
	);
	const menu = (
		<Menu position="bottom-end" shadow="md" withinPortal>
			<Menu.Target>
				<ActionIcon
					size={30}
					variant="subtle"
					color="gray"
					aria-label={t("teams.page.header.more")}
					data-testid="team-more-menu"
				>
					<IconDots size={18} aria-hidden />
				</ActionIcon>
			</Menu.Target>
			<Menu.Dropdown>
				{phone && canPause && (
					<Menu.Item
						leftSection={<IconPlayerPause size={14} />}
						onClick={() => setConfirmPause(true)}
						data-testid="team-pause-all"
					>
						{t("teams.page.header.pauseAll")}
					</Menu.Item>
				)}
				{canEdit && onOpenSettings && (
					<Menu.Item
						leftSection={<IconSettings size={14} />}
						onClick={onOpenSettings}
						data-testid="team-settings"
					>
						{t("teams.page.header.settings")}
					</Menu.Item>
				)}
				{onOpenCoordinatorSession && (
					<Menu.Item
						leftSection={<IconExternalLink size={14} />}
						onClick={onOpenCoordinatorSession}
						data-testid="team-full-session"
					>
						{t("teams.page.header.fullSession")}
					</Menu.Item>
				)}
				{member && onDisband && (
					<>
						<Menu.Divider />
						<Menu.Item
							color="red"
							leftSection={<IconUsersMinus size={14} />}
							onClick={onDisband}
							data-testid="team-disband"
						>
							{t("teams.page.header.disband")}
						</Menu.Item>
					</>
				)}
			</Menu.Dropdown>
		</Menu>
	);
	const pin = pinTitle !== undefined && (
		<PinToSidebarButton type="team" id={teamId} title={pinTitle} />
	);
	const people = summary && (
		<MemberAvatars projectId={projectId} teamId={teamId} onOpen={() => setMembersOpen(true)} />
	);

	return (
		<Box
			px={phone ? "sm" : "md"}
			py={phone ? 8 : 10}
			data-testid="team-top-bar"
			data-phone={phone ? "true" : "false"}
			style={{ borderBottom: "1px solid var(--mantine-color-default-border)", flexShrink: 0 }}
		>
			{phone ? (
				<Stack gap={4}>
					<Group gap={8} wrap="nowrap">
						{/* The page's own title row carries the phone menu button (no floating one). */}
						<MobileNavButton />
						{name}
						<Box style={{ flex: 1 }} />
						{pin}
						{menu}
					</Group>
					<Group gap={8} wrap="nowrap" justify="space-between" pl={4}>
						{status && <StatusSentence {...status} />}
						{people}
					</Group>
				</Stack>
			) : (
				<Group gap="sm" wrap="nowrap" justify="space-between">
					<Group gap={8} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
						<MobileNavButton />
						{back}
						{projectName && (
							<>
								<UnstyledButton onClick={onBack} style={{ minWidth: 0, flexShrink: 1 }}>
									<Text size="sm" c="dimmed" truncate data-testid="team-crumb-project">
										{projectName}
									</Text>
								</UnstyledButton>
								<Text size="sm" c="dimmed" aria-hidden>
									/
								</Text>
							</>
						)}
						{name}
						{status && (
							<Box style={{ minWidth: 0, flexShrink: 1 }} ml={4}>
								<StatusSentence {...status} />
							</Box>
						)}
					</Group>
					<Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
						{people}
						{pin}
						{canPause && (
							<Button
								size="xs"
								variant="default"
								leftSection={<IconPlayerPause size={14} aria-hidden />}
								onClick={() => setConfirmPause(true)}
								data-testid="team-pause-all"
							>
								{t("teams.page.header.pauseAll")}
							</Button>
						)}
						{menu}
					</Group>
				</Group>
			)}
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
						<Button loading={pause.isPending} onClick={pauseAll} data-testid="team-pause-confirm">
							{t("teams.top.pauseConfirmButton")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Box>
	);
}
