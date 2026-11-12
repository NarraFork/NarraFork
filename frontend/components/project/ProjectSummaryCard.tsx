import type { ApiEntity } from "@frontend/lib/api/types";
import { statusRegistry } from "@frontend/lib/status-registry";
import { Badge, Card, Group, Text } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export function ProjectSummaryCard({ project }: { project: ApiEntity }) {
	const { t } = useTranslation("common");
	return (
		<Link
			to="/projects/$projectId"
			params={{ projectId: String(project.id) }}
			style={{ textDecoration: "none" }}
		>
			<Card shadow="sm" padding="lg" radius="md" withBorder h="100%">
				<Group justify="space-between" mb="xs">
					<Text fw={500}>{project.name}</Text>
					<Badge color={statusRegistry.projectStatus(project.status).color}>
						{t(statusRegistry.projectStatus(project.status).i18nKey)}
					</Badge>
				</Group>
				{project.description && (
					<Text size="sm" c="dimmed" lineClamp={2}>
						{project.description}
					</Text>
				)}
			</Card>
		</Link>
	);
}
