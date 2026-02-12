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
				<Title order={2}>Projects</Title>
				<Button onClick={open}>New Project</Button>
			</Group>

			{!projects?.length ? (
				<Text c="dimmed">No projects yet. Create one to get started.</Text>
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

			<Modal opened={opened} onClose={close} title="New Project">
				<Stack>
					<TextInput
						label="Project Name"
						placeholder="My Project"
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						required
					/>
					<TextInput
						label="Repository Path"
						placeholder="/home/user/projects/my-repo"
						value={repoPath}
						onChange={(e) => setRepoPath(e.currentTarget.value)}
						description="Local path to an existing git repository"
					/>
					<Button onClick={handleCreate} loading={createProject.isPending}>
						Create
					</Button>
				</Stack>
			</Modal>
		</Stack>
	);
}
