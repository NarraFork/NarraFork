/**
 * The project page's header (R2): the project's name with 「固定到侧栏」, then the repository path
 * (its tail; the whole path on hover), the default branch and 「N 位成员」 (a count from the server;
 * it opens the settings page's 成员与可见性); on the right 「新团队」 (secondary),
 * 「新会话」 (primary) and the 「…」 menu (项目设置, and with the outline on: open the outline, the
 * task board).
 *
 * On a phone: the page's own menu button starts the title row (so the shell's floating one never
 * covers the title), the path goes under it, and the two buttons share a row below.
 */
import { MobileNavButton } from "@frontend/components/nav/MobileNavButton";
import { PinToSidebarButton } from "@frontend/components/nav/PinToSidebarButton";
import {
	ActionIcon,
	Box,
	Button,
	Group,
	Menu,
	Skeleton,
	Stack,
	Text,
	Title,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import type { ProjectMemberCount } from "@shared/project-overview";
import {
	IconDots,
	IconEdit,
	IconGitBranch,
	IconLayoutKanban,
	IconListTree,
	IconMessages,
	IconSettings,
	IconUsers,
	IconUsersGroup,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { MONO } from "../teams/team-page-ui";
import { pathTail } from "./project-page-model";

export interface ProjectHeaderProps {
	projectId: string;
	name: string | null;
	gitPath: string | null;
	defaultBranch: string | null;
	description?: string | null;
	phone: boolean;
	canWrite: boolean;
	/** Teams are available on this deployment (not PostgreSQL). */
	teamsAvailable: boolean;
	onNewSession: () => void;
	onNewTeam: () => void;
	onOpenSettings: () => void;
	/** 「N 位成员」; nothing while unknown (or when the count could not be read). */
	memberCount?: ProjectMemberCount | null;
	/** Opens the settings page at 成员与可见性. */
	onOpenMembers?: () => void;
	outline?: {
		pending: boolean;
		showingTasks: boolean;
		onOpen: () => void;
		onToggleTasks: () => void;
	};
}

export function ProjectHeader({
	projectId,
	name,
	gitPath,
	defaultBranch,
	description,
	phone,
	canWrite,
	teamsAvailable,
	onNewSession,
	onNewTeam,
	onOpenSettings,
	memberCount,
	onOpenMembers,
	outline,
}: ProjectHeaderProps) {
	const { t } = useTranslation("projects");
	const { t: tOutline } = useTranslation("outline");
	const title = name ? (
		<Title
			order={phone ? 3 : 2}
			fz={phone ? 20 : 26}
			lh={1.2}
			style={{ minWidth: 0 }}
			lineClamp={1}
		>
			{name}
		</Title>
	) : (
		<Skeleton height={28} width={200} />
	);
	const pin = name ? <PinToSidebarButton type="project" id={projectId} title={name} /> : null;
	const meta = (
		<Group gap={14} wrap="wrap" style={{ rowGap: 2 }} data-testid="project-meta">
			{gitPath && (
				<Tooltip label={gitPath} withinPortal openDelay={300}>
					<Text size="xs" c="dimmed" style={MONO} data-testid="project-path" data-path={gitPath}>
						{pathTail(gitPath, 2)}
					</Text>
				</Tooltip>
			)}
			{defaultBranch && (
				<Group gap={4} wrap="nowrap">
					<IconGitBranch size={13} aria-hidden style={{ opacity: 0.6 }} />
					<Text size="xs" c="dimmed" style={MONO}>
						{defaultBranch}
					</Text>
				</Group>
			)}
			{memberCount && (
				<Tooltip label={t("page.membersHint")} withinPortal openDelay={300}>
					<UnstyledButton
						onClick={onOpenMembers}
						disabled={!onOpenMembers}
						data-testid="project-member-count"
						data-count={memberCount.count}
					>
						<Group gap={4} wrap="nowrap">
							<IconUsers size={13} aria-hidden style={{ opacity: 0.6 }} />
							<Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
								{memberCount.more
									? t("page.membersMore", { count: memberCount.count })
									: t("page.members", { count: memberCount.count })}
							</Text>
						</Group>
					</UnstyledButton>
				</Tooltip>
			)}
		</Group>
	);
	const newSession = (
		<Button
			leftSection={<IconEdit size={16} aria-hidden />}
			disabled={!canWrite}
			onClick={onNewSession}
			fullWidth={phone}
			data-testid="project-new-session"
		>
			{t("page.newSession")}
		</Button>
	);
	const newTeam = teamsAvailable ? (
		<Button
			variant="default"
			leftSection={<IconUsersGroup size={16} aria-hidden />}
			disabled={!canWrite}
			onClick={onNewTeam}
			fullWidth={phone}
			data-testid="project-new-team"
		>
			{t("page.newTeam")}
		</Button>
	) : null;
	const menu = (
		<Menu position="bottom-end" shadow="md" withinPortal>
			<Menu.Target>
				<ActionIcon
					size={34}
					variant="subtle"
					color="gray"
					aria-label={t("page.more")}
					data-testid="project-more-menu"
				>
					<IconDots size={18} aria-hidden />
				</ActionIcon>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Item
					leftSection={<IconSettings size={14} />}
					onClick={onOpenSettings}
					data-testid="project-open-settings"
				>
					{t("settingsPage.title")}
				</Menu.Item>
				{outline && (
					<>
						<Menu.Divider />
						<Menu.Item
							leftSection={<IconListTree size={14} />}
							disabled={outline.pending}
							onClick={outline.onOpen}
						>
							{t("openOutline")}
						</Menu.Item>
						<Menu.Item
							leftSection={
								outline.showingTasks ? <IconMessages size={14} /> : <IconLayoutKanban size={14} />
							}
							onClick={outline.onToggleTasks}
							data-testid="project-toggle-tasks"
						>
							{outline.showingTasks ? t("page.showSessions") : tOutline("board.projectTitle")}
						</Menu.Item>
					</>
				)}
			</Menu.Dropdown>
		</Menu>
	);

	if (phone)
		return (
			<Stack gap={10} data-testid="project-header" data-phone="true">
				<Group gap={8} wrap="nowrap">
					<MobileNavButton />
					<Box style={{ flex: 1, minWidth: 0 }}>{title}</Box>
					{pin}
					{menu}
				</Group>
				<Box pl={36}>{meta}</Box>
				<Group gap={8} wrap="nowrap" grow>
					{newSession}
					{newTeam}
				</Group>
			</Stack>
		);
	return (
		<Group justify="space-between" align="flex-start" wrap="nowrap" data-testid="project-header">
			<Stack gap={6} style={{ minWidth: 0 }}>
				<Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
					<MobileNavButton />
					{title}
					{pin}
				</Group>
				{meta}
				{description && (
					<Text size="sm" c="dimmed" lineClamp={2}>
						{description}
					</Text>
				)}
			</Stack>
			<Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
				{newTeam}
				{newSession}
				{menu}
			</Group>
		</Group>
	);
}
