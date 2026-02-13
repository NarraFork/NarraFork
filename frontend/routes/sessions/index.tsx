import { Button, Card, Group, Loader, Modal, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCreateSession, useDeleteSession, useSessions } from "../../hooks/useSessions";

export const Route = createFileRoute("/sessions/")({
	component: SessionsPage,
});

function SessionsPage() {
	const { data: sessions, isLoading } = useSessions();
	const createSession = useCreateSession();
	const deleteSession = useDeleteSession();
	const [opened, { open, close }] = useDisclosure(false);

	const handleCreate = () => {
		createSession.mutate(
			{},
			{
				onSuccess: () => close(),
			},
		);
	};

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>Standalone Sessions</Title>
				<Button onClick={open}>New Session</Button>
			</Group>

			{isLoading ? (
				<Loader />
			) : !sessions?.length ? (
				<Text c="dimmed">No standalone sessions. Create one to start a conversation without a chapter.</Text>
			) : (
				<Stack>
					{sessions.map((session: any) => (
						<Link
							key={session.id}
							to="/sessions/$sessionId"
							params={{ sessionId: session.id }}
							style={{ textDecoration: "none", color: "inherit" }}
						>
							<Card
								shadow="sm"
								padding="md"
								withBorder
							>
								<Group justify="space-between">
									<div>
										<Text fw={500}>Session {session.id.slice(0, 8)}</Text>
										<Text size="sm" c="dimmed">
											{session.model} &middot; {session.messageCount ?? 0} messages
										</Text>
									</div>
									<Group>
										<Text size="xs" c="dimmed">
											{new Date(session.createdAt).toLocaleDateString()}
										</Text>
										<Button
											size="xs"
											color="red"
											variant="subtle"
											onClick={(e) => {
												e.preventDefault();
												e.stopPropagation();
												deleteSession.mutate(session.id);
											}}
										>
											Delete
										</Button>
									</Group>
								</Group>
							</Card>
						</Link>
					))}
				</Stack>
			)}

			<Modal opened={opened} onClose={close} title="New Standalone Session">
				<Stack>
					<Text size="sm" c="dimmed">
						Create a standalone AI session not bound to any chapter. Useful for general questions and explorations.
					</Text>
					<Button onClick={handleCreate} loading={createSession.isPending}>
						Create Session
					</Button>
				</Stack>
			</Modal>
		</Stack>
	);
}
