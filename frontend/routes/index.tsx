import { Badge, Card, Group, Loader, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

export const Route = createFileRoute("/")({
	component: DashboardPage,
});

function DashboardPage() {
	const { t } = useTranslation("dashboard");
	const { data: projects, isLoading: projectsLoading } = useQuery({
		queryKey: ["projects"],
		queryFn: () => api.listProjects(),
	});
	const { data: sessions } = useQuery({
		queryKey: ["sessions"],
		queryFn: api.listSessions,
	});

	if (projectsLoading) return <Loader />;

	const activeProjects = projects?.filter((p: any) => p.status === "active") ?? [];

	return (
		<Stack>
			<Title>{t("welcome")}</Title>
			<Text c="dimmed">{t("subtitle")}</Text>

			<SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
				<StatCard label={t("activeProjects")} value={activeProjects.length} color="indigo" />
				<StatCard label={t("totalProjects")} value={projects?.length ?? 0} color="blue" />
				<StatCard label={t("standaloneSessions")} value={sessions?.length ?? 0} color="violet" />
			</SimpleGrid>

			{activeProjects.length > 0 && (
				<>
					<Title order={3} mt="md">
						{t("recentProjects")}
					</Title>
					<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
						{activeProjects.slice(0, 6).map((project: any) => (
							<Card
								key={project.id}
								withBorder
								component={Link}
								to="/projects/$projectId"
								params={{ projectId: project.id }}
								style={{ textDecoration: "none" }}
							>
								<Group justify="space-between" mb="xs">
									<Text fw={500}>{project.name}</Text>
									<Badge color="green" size="sm">
										{project.status}
									</Badge>
								</Group>
								{project.description && (
									<Text size="sm" c="dimmed" lineClamp={2}>
										{project.description}
									</Text>
								)}
							</Card>
						))}
					</SimpleGrid>
				</>
			)}
		</Stack>
	);
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
	return (
		<Card withBorder>
			<Text size="xs" tt="uppercase" fw={700} c="dimmed">
				{label}
			</Text>
			<Text size="xl" fw={700} c={color}>
				{value}
			</Text>
		</Card>
	);
}
