import { Button, Card, Group, Loader, Modal, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useCreateSession, useDeleteSession, useSessions } from "../../hooks/useSessions";

export const Route = createFileRoute("/sessions/")({
	component: SessionsPage,
});

function SessionsPage() {
	const { data: sessions, isLoading } = useSessions();
	const createSession = useCreateSession();
	const deleteSession = useDeleteSession();
	const [opened, { open, close }] = useDisclosure(false);
	const { t } = useTranslation("sessions");
	const { t: tc } = useTranslation("common");
	const { i18n } = useTranslation();

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
				<Title order={2}>{t("title")}</Title>
				<Button onClick={open}>{t("newSession")}</Button>
			</Group>

			{isLoading ? (
				<Loader />
			) : !sessions?.length ? (
				<Text c="dimmed">{t("noSessions")}</Text>
			) : (
				<Stack>
					{sessions.map((session: any) => (
						<Link
							key={session.id}
							to="/sessions/$sessionId"
							params={{ sessionId: session.id }}
							style={{ textDecoration: "none", color: "inherit" }}
						>
							<Card shadow="sm" padding="md" withBorder>
								<Group justify="space-between">
									<div>
										<Text fw={500}>{t("sessionId", { id: session.id.slice(0, 8) })}</Text>
										<Text size="sm" c="dimmed">
											{t("sessionMeta", {
												model: session.model,
												count: session.messageCount ?? 0,
											})}
										</Text>
									</div>
									<Group>
										<Text size="xs" c="dimmed">
											{new Date(session.createdAt).toLocaleDateString(i18n.language)}
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
											{tc("delete")}
										</Button>
									</Group>
								</Group>
							</Card>
						</Link>
					))}
				</Stack>
			)}

			<Modal opened={opened} onClose={close} title={t("newSessionModal")}>
				<Stack>
					<Text size="sm" c="dimmed">
						{t("newSessionDescription")}
					</Text>
					<Button onClick={handleCreate} loading={createSession.isPending}>
						{t("createSession")}
					</Button>
				</Stack>
			</Modal>
		</Stack>
	);
}
