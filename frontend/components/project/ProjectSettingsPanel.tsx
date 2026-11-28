/**
 * A session's project settings entry (the session menu's dialog, `NarratorProjectSettings.tsx`):
 * which project the session belongs to, whether this person may manage it, and the way to the
 * project's settings page (`/projects/$projectId/settings`, R2), where every project setting now
 * lives. Instance-level workspace, device and knowledge settings are linked as before.
 */
import { Alert, Button, Card, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { IconSettings } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useProjectAccess } from "../../hooks/useProjectAccess";
import { useProject } from "../../hooks/useProjects";

export function ProjectSettingsPanel({ projectId }: { projectId: string }) {
	const { t } = useTranslation("projects");
	const project = useProject(projectId);
	const access = useProjectAccess(projectId);
	const canManage = !access.isError && access.data?.canManage === true;
	if (project.isLoading) return <Loader size="sm" />;
	if (project.isError || !project.data)
		return <Alert color="red">{t("compatibility.unavailable")}</Alert>;
	return (
		<Card withBorder>
			<Stack gap="sm">
				<Title order={4}>{t("compatibility.title")}</Title>
				<Text>{t("compatibility.source", { name: project.data.name })}</Text>
				<Text size="sm" c="dimmed">
					{t(canManage ? "compatibility.manage" : "compatibility.readOnly")}
				</Text>
				{access.isError && <Alert color="red">{t("compatibility.accessUnavailable")}</Alert>}
				<Group>
					<Link
						to="/projects/$projectId/settings"
						params={{ projectId }}
						style={{ textDecoration: "none" }}
						data-testid="open-project-settings"
					>
						<Button component="span" leftSection={<IconSettings size={16} aria-hidden />}>
							{t("settingsPage.open")}
						</Button>
					</Link>
				</Group>
				<Group>
					<Button variant="subtle" component={Link} to="/settings/workspace">
						{t("compatibility.workspaceContainers")}
					</Button>
					<Button variant="subtle" component={Link} to="/settings/devices">
						{t("compatibility.devices")}
					</Button>
					<Button variant="subtle" component={Link} to="/knowledge">
						{t("compatibility.knowledge")}
					</Button>
				</Group>
				<Text size="xs" c="dimmed">
					{t("compatibility.instanceSource")}
				</Text>
			</Stack>
		</Card>
	);
}
