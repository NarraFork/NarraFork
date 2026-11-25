/**
 * The project settings page `/projects/$projectId/settings` (R2): everything the project page's
 * old folded 「高级设置」 held, on its own page, in seven groups — 成员与可见性, 技能, 例程, 命令,
 * 工作区与容器, 设备, 知识库. A group nav on the left (a row of chips on a phone) scrolls to each
 * group; every group has a title, one line of what it is for, then its editors. Changes save as
 * they are made.
 *
 * Editing needs project management permission (`useProjectAccess().canManage`, verified: a failed
 * permission read disables editing); anyone who can read the project sees the page read-only.
 * Devices, workspace defaults and the knowledge base are instance-level or have their own access
 * rules: their groups link there.
 */
import { MobileNavButton } from "@frontend/components/nav/MobileNavButton";
import {
	ActionIcon,
	Alert,
	Box,
	Button,
	Divider,
	Group,
	Loader,
	ScrollArea,
	Skeleton,
	Stack,
	Text,
	Title,
	UnstyledButton,
} from "@mantine/core";
import {
	IconArrowLeft,
	IconBook2,
	IconBox,
	IconDeviceLaptop,
	IconRepeat,
	IconSparkles,
	IconTerminal2,
	IconUsersGroup,
} from "@tabler/icons-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectAccess } from "../../hooks/useProjectAccess";
import { useProject } from "../../hooks/useProjects";
import { TraitLayerEditor } from "../settings/TraitLayerEditor";
import { ProjectAccessPanel } from "./ProjectAccessPanel";
import { ProjectRoutinesList } from "./ProjectRoutinesList";
import {
	ProjectBasicsForm,
	ProjectCommandsEditor,
	ProjectRuleList,
	ProjectTeamDefaults,
} from "./ProjectSettingsForms";
import { ProjectSkillsManager } from "./ProjectSkillsManager";

/** The page's groups, in order (anchors `#settings-<key>`). */
export const PROJECT_SETTINGS_GROUPS = [
	"members",
	"skills",
	"routines",
	"commands",
	"workspace",
	"devices",
	"knowledge",
] as const;
export type ProjectSettingsGroup = (typeof PROJECT_SETTINGS_GROUPS)[number];

/** The group a `#settings-<group>` hash names, if any. */
export function groupOfHash(hash: string): ProjectSettingsGroup | null {
	const key = hash.replace(/^#/, "").replace(/^settings-/, "");
	return (PROJECT_SETTINGS_GROUPS as readonly string[]).includes(key)
		? (key as ProjectSettingsGroup)
		: null;
}

const GROUP_ICON: Record<ProjectSettingsGroup, ComponentType<{ size?: number }>> = {
	members: IconUsersGroup,
	skills: IconSparkles,
	routines: IconRepeat,
	commands: IconTerminal2,
	workspace: IconBox,
	devices: IconDeviceLaptop,
	knowledge: IconBook2,
};

function Section({
	group,
	children,
	action,
}: {
	group: ProjectSettingsGroup;
	children: ReactNode;
	action?: ReactNode;
}) {
	const { t } = useTranslation("projects");
	return (
		<Box
			component="section"
			id={`settings-${group}`}
			data-testid={`project-settings-${group}`}
			style={{ scrollMarginTop: 72 }}
		>
			<Group justify="space-between" align="flex-start" wrap="nowrap" gap="sm">
				<Stack gap={4} style={{ minWidth: 0 }}>
					<Title order={4}>{t(`settingsPage.groups.${group}.title`)}</Title>
					<Text size="sm" c="dimmed">
						{t(`settingsPage.groups.${group}.description`)}
					</Text>
				</Stack>
				{action}
			</Group>
			<Box mt="md">{children}</Box>
		</Box>
	);
}

export function ProjectSettingsPage({ projectId }: { projectId: string }) {
	const { t } = useTranslation("projects");
	const { t: ts } = useTranslation("settings");
	const navigate = useNavigate();
	const project = useProject(projectId);
	const access = useProjectAccess(projectId, !project.isError);
	const [active, setActive] = useState<ProjectSettingsGroup>(
		() => groupOfHash(typeof window === "undefined" ? "" : window.location.hash) ?? "members",
	);
	// Only a verified permission enables editing: a failed refresh never keeps stale controls.
	const canManage = !access.isError && access.data?.canManage === true;
	const back = () => void navigate({ to: "/projects/$projectId", params: { projectId } });
	const loaded = !!project.data;
	// Opened at a group (`#settings-members`, the project header's 「N 位成员」): go there once
	// the groups are drawn.
	useEffect(() => {
		if (!loaded) return;
		const group = groupOfHash(window.location.hash);
		if (group) document.getElementById(`settings-${group}`)?.scrollIntoView({ block: "start" });
	}, [loaded]);

	if (project.isError || (!project.isLoading && !project.data))
		return <Alert color="red">{t("compatibility.unavailable")}</Alert>;
	const data = project.data;
	const jump = (group: ProjectSettingsGroup) => {
		setActive(group);
		document
			.getElementById(`settings-${group}`)
			?.scrollIntoView({ behavior: "smooth", block: "start" });
	};
	const nav = (phone: boolean) =>
		PROJECT_SETTINGS_GROUPS.map((group) => {
			const Icon = GROUP_ICON[group];
			const selected = active === group;
			return (
				<UnstyledButton
					key={group}
					onClick={() => jump(group)}
					data-testid="project-settings-nav"
					data-group={group}
					aria-current={selected ? "true" : undefined}
					px={10}
					py={phone ? 4 : 7}
					style={{
						borderRadius: "var(--mantine-radius-sm)",
						flexShrink: 0,
						whiteSpace: "nowrap",
						color: selected ? "var(--mantine-primary-color-light-color)" : undefined,
						background: selected ? "var(--mantine-primary-color-light)" : undefined,
						border: phone ? "1px solid var(--mantine-color-default-border)" : undefined,
					}}
				>
					<Group gap={8} wrap="nowrap">
						<Icon size={16} />
						<Text size="sm" inherit>
							{t(`settingsPage.groups.${group}.title`)}
						</Text>
					</Group>
				</UnstyledButton>
			);
		});

	return (
		<Stack gap={0} data-testid="project-settings-page">
			<Group
				gap={8}
				wrap="nowrap"
				pb="sm"
				mb="md"
				style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
			>
				<MobileNavButton />
				<ActionIcon
					variant="subtle"
					color="gray"
					size={28}
					aria-label={t("settingsPage.back")}
					onClick={back}
					data-testid="project-settings-back"
				>
					<IconArrowLeft size={16} />
				</ActionIcon>
				{data ? (
					<UnstyledButton onClick={back} style={{ minWidth: 0, flexShrink: 1 }}>
						<Text size="sm" c="dimmed" truncate data-testid="project-settings-crumb">
							{String(data.name ?? "")}
						</Text>
					</UnstyledButton>
				) : (
					<Skeleton height={16} width={120} />
				)}
				<Text size="sm" c="dimmed" aria-hidden>
					/
				</Text>
				<Text fw={700} style={{ flexShrink: 0 }}>
					{t("settingsPage.title")}
				</Text>
				<Text size="xs" c="dimmed" visibleFrom="sm" truncate>
					{t("settingsPage.autosave")}
				</Text>
			</Group>
			{!data ? (
				<Loader size="sm" />
			) : (
				<Group align="flex-start" gap="xl" wrap="nowrap">
					<Stack
						gap={2}
						w={190}
						visibleFrom="sm"
						style={{ position: "sticky", top: 16, flexShrink: 0 }}
					>
						{nav(false)}
					</Stack>
					<Stack gap="xl" style={{ flex: 1, minWidth: 0, maxWidth: 760 }}>
						<ScrollArea hiddenFrom="sm" type="never">
							<Group gap={6} wrap="nowrap">
								{nav(true)}
							</Group>
						</ScrollArea>
						{access.isError && (
							<Alert color="red" variant="light">
								{t("compatibility.accessUnavailable")}
							</Alert>
						)}
						{!access.isLoading && !canManage && !access.isError && (
							<Alert color="gray" variant="light" data-testid="project-settings-read-only">
								{t("compatibility.readOnly")}
							</Alert>
						)}
						<Section group="members">
							<ProjectAccessPanel projectId={projectId} />
						</Section>
						<Divider />
						<Section group="skills">
							<ProjectSkillsManager
								projectId={projectId}
								enabled={canManage}
								disabledReason={canManage ? undefined : t("compatibility.readOnly")}
							/>
						</Section>
						<Divider />
						<Section group="routines">
							<Stack gap="lg">
								<ProjectRoutinesList projectId={projectId} canManage={canManage} />
								<Stack gap={6}>
									<Text size="sm" fw={600}>
										{ts("traitLayerProjectTitle")}
									</Text>
									<Text size="xs" c="dimmed">
										{ts("traitLayerProjectDesc")}
									</Text>
									{canManage ? (
										<TraitLayerEditor layer="project" ownerId={projectId} />
									) : (
										<Text size="sm" c="dimmed">
											{t("compatibility.readOnly")}
										</Text>
									)}
								</Stack>
							</Stack>
						</Section>
						<Divider />
						<Section group="commands">
							<Stack gap="lg">
								<ProjectCommandsEditor project={data} canManage={canManage} />
								<ProjectRuleList project={data} ruleKey="commandWhitelist" canManage={canManage} />
								<ProjectRuleList project={data} ruleKey="commandBlacklist" canManage={canManage} />
							</Stack>
						</Section>
						<Divider />
						<Section
							group="workspace"
							action={
								<Button
									size="xs"
									variant="default"
									component={Link}
									to="/settings/workspace"
									style={{ flexShrink: 0 }}
								>
									{t("compatibility.workspaceContainers")}
								</Button>
							}
						>
							<Stack gap="lg">
								<ProjectBasicsForm project={data} canManage={canManage} />
								<ProjectTeamDefaults project={data} canManage={canManage} />
								<ProjectRuleList project={data} ruleKey="whitelistDirs" canManage={canManage} />
								<ProjectRuleList project={data} ruleKey="blacklistDirs" canManage={canManage} />
							</Stack>
						</Section>
						<Divider />
						<Section
							group="devices"
							action={
								<Button
									size="xs"
									variant="default"
									component={Link}
									to="/settings/devices"
									style={{ flexShrink: 0 }}
								>
									{t("settingsPage.openDevices")}
								</Button>
							}
						>
							<Text size="sm" c="dimmed">
								{t("compatibility.instanceSource")}
							</Text>
						</Section>
						<Divider />
						<Section
							group="knowledge"
							action={
								<Button
									size="xs"
									variant="default"
									component={Link}
									to="/knowledge"
									style={{ flexShrink: 0 }}
								>
									{t("settingsPage.openKnowledge")}
								</Button>
							}
						>
							<Text size="sm" c="dimmed">
								{t("settingsPage.knowledgeNote")}
							</Text>
						</Section>
						<Box h={80} />
					</Stack>
				</Group>
			)}
		</Stack>
	);
}
