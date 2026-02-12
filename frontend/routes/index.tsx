import { Button, Stack, Text, Title } from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: DashboardPage,
});

function DashboardPage() {
	return (
		<Stack>
			<Title>Welcome to NarraFork</Title>
			<Text c="dimmed">AI-powered collaborative programming platform.</Text>
			<Button component={Link} to="/projects" w="fit-content">
				View Projects
			</Button>
		</Stack>
	);
}
