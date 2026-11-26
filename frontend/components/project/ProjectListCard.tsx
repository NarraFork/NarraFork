/**
 * One card of the project list (R2): the name and an amber 「N 等你」 badge, the path tail, how many
 * sessions are running and how many teams there are, and when it last had activity. The numbers
 * come from the list's one summary request (`useProjectSummaries`); without them (still loading,
 * or not available here) the card shows the name and path only.
 */
import { Badge, Box, Divider, Group, Text } from "@mantine/core";
import type { ProjectListSummary } from "@shared/project-overview";
import { IconFolder, IconUsersGroup } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ATTENTION_COLOR, MONO, StatusDot, TABULAR } from "../teams/team-page-ui";
import { activityAgo, pathTail } from "./project-page-model";

export interface ProjectListCardProject {
	id: string;
	name: string;
	gitPath?: string | null;
	status?: string | null;
	updatedAt?: string | null;
}

export function ProjectListCard({
	project,
	summary,
	now,
}: {
	project: ProjectListCardProject;
	summary: ProjectListSummary | undefined;
	now: Date;
}) {
	const { t, i18n } = useTranslation("projects");
	const more = summary?.capped ? "+" : "";
	const running = summary?.runningSessionCount ?? 0;
	const waiting = summary?.waitingCount ?? 0;
	const ago = activityAgo(summary?.lastActivityAt ?? project.updatedAt, now);
	const at = summary?.lastActivityAt ?? project.updatedAt;
	const agoText =
		ago.key === "date" && at
			? new Date(at).toLocaleDateString(i18n.resolvedLanguage ?? i18n.language, {
					month: "short",
					day: "numeric",
				})
			: t(`list.activity.${ago.key}`, { count: ago.count });
	return (
		<Link
			to="/projects/$projectId"
			params={{ projectId: project.id }}
			style={{ textDecoration: "none", color: "inherit" }}
			data-testid="project-card"
			data-project-id={project.id}
		>
			<Box
				className="nf-project-card"
				p="md"
				h="100%"
				style={{
					borderRadius: "var(--mantine-radius-md)",
					border: "1px solid var(--mantine-color-default-border)",
					background: "var(--mantine-color-default)",
				}}
			>
				<Group justify="space-between" wrap="nowrap" gap="xs">
					<Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
						<IconFolder size={16} aria-hidden style={{ flexShrink: 0, opacity: 0.7 }} />
						<Text fw={700} truncate>
							{project.name}
						</Text>
						{project.status === "archived" && (
							<Badge size="xs" variant="light" color="gray" tt="none">
								{t("list.archived")}
							</Badge>
						)}
					</Group>
					{waiting > 0 && (
						<Badge
							size="sm"
							variant="filled"
							tt="none"
							style={{
								background: ATTENTION_COLOR,
								color: "var(--mantine-color-dark-9)",
								flexShrink: 0,
								...TABULAR,
							}}
							data-testid="project-card-waiting"
						>
							{t(summary?.capped ? "page.waitingBadgeMore" : "page.waitingBadge", {
								count: waiting,
							})}
						</Badge>
					)}
				</Group>
				{project.gitPath && (
					<Text size="xs" c="dimmed" mt={4} truncate style={MONO} title={project.gitPath}>
						{pathTail(project.gitPath, 2)}
					</Text>
				)}
				{summary && (
					<Group gap={16} mt="sm" wrap="wrap" style={{ rowGap: 4 }}>
						<Group gap={6} wrap="nowrap">
							<StatusDot tone={running > 0 ? "blue" : "hollow"} />
							<Text size="xs" c="dimmed" style={TABULAR} data-testid="project-card-running">
								{running > 0
									? t("list.runningSessions", { count: running, more })
									: t("list.noRunningSessions")}
							</Text>
						</Group>
						{summary.teamCount > 0 && (
							<Group gap={6} wrap="nowrap">
								<IconUsersGroup size={13} aria-hidden style={{ opacity: 0.6 }} />
								<Text size="xs" c="dimmed" style={TABULAR} data-testid="project-card-teams">
									{t("list.teams", { count: summary.teamCount, more })}
								</Text>
							</Group>
						)}
					</Group>
				)}
				<Divider my="sm" />
				<Text size="xs" c="dimmed" style={TABULAR} data-testid="project-card-activity">
					{agoText}
				</Text>
			</Box>
		</Link>
	);
}
