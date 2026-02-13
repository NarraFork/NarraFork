import {
	Badge,
	Button,
	Card,
	Group,
	Loader,
	Modal,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCreateProject, useProjects } from "../../hooks/useProjects";

export const Route = createFileRoute("/projects/")({
	component: ProjectListPage,
});

function ProjectListPage() {
	const { data: projects, isLoading } = useProjects();
	const createProject = useCreateProject();
	const [opened, { open, close }] = useDisclosure(false);
	const [name, setName] = useState("");
	const [repoPath, setRepoPath] = useState("");
	const { t } = useTranslation("projects");
	const { t: tc } = useTranslation("common");

	const handleCreate = () => {
		if (!name.trim()) return;
		createProject.mutate(
			{ name: name.trim(), repositoryPath: repoPath.trim() || undefined },
			{
				onSuccess: () => {
					close();
					setName("");
					setRepoPath("");
				},
			},
		);
	};

	if (isLoading) return <Loader />;

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>{t("title")}</Title>
				<Button onClick={open}>{t("newProject")}</Button>
			</Group>

			{!projects?.length ? (
				<Text c="dimmed">{t("noProjects")}</Text>
			) : (
				<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
					{projects.map((project: any) => (
						<Card
							key={project.id}
							shadow="sm"
							padding="lg"
							radius="md"
							withBorder
							component={Link}
							to="/projects/$projectId"
							params={{ projectId: project.id } as any}
							style={{ textDecoration: "none" }}
						>
							<Group justify="space-between" mb="xs">
								<Text fw={500}>{project.name}</Text>
								<Badge color={project.status === "active" ? "green" : "gray"}>
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
			)}

			<Modal opened={opened} onClose={close} title={t("newProject")}>
				<Stack>
					<TextInput
						label={t("projectName")}
						placeholder={t("projectNamePlaceholder")}
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						required
					/>
					<TextInput
						label={t("repositoryPath")}
						placeholder={t("repositoryPathPlaceholder")}
						value={repoPath}
						onChange={(e) => setRepoPath(e.currentTarget.value)}
						description={t("repositoryPathDescription")}
					/>
					<Button onClick={handleCreate} loading={createProject.isPending}>
						{tc("create")}
					</Button>
				</Stack>
			</Modal>
		</Stack>
	);
}
