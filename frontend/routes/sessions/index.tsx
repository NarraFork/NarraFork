import {
	ActionIcon,
	Button,
	Card,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconFolder, IconStar, IconStarFilled, IconX } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCreateFavoriteDirectory,
	useDeleteFavoriteDirectory,
	useFavoriteDirectories,
} from "../../hooks/useFavoriteDirectories";
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
	const [cwd, setCwd] = useState("");
	const { data: favorites } = useFavoriteDirectories();
	const addFavorite = useCreateFavoriteDirectory();
	const removeFavorite = useDeleteFavoriteDirectory();

	const isFavorited = favorites?.some((f: any) => f.path === cwd);

	const handleCreate = () => {
		createSession.mutate(
			{ ...(cwd ? { cwd } : {}) },
			{
				onSuccess: () => {
					close();
					setCwd("");
				},
			},
		);
	};

	const handleClose = () => {
		close();
		setCwd("");
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
										<Text fw={500}>
											{session.title || t("sessionId", { id: session.id.slice(0, 8) })}
										</Text>
										<Text size="sm" c="dimmed">
											{t("sessionMeta", {
												model: session.model,
												count: session.messageCount ?? 0,
											})}
										</Text>
										{session.cwd && (
											<Text size="xs" c="dimmed" truncate>
												{t("cwdLabel", { path: session.cwd })}
											</Text>
										)}
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

			<Modal opened={opened} onClose={handleClose} title={t("newSessionModal")}>
				<Stack>
					<Text size="sm" c="dimmed">
						{t("newSessionDescription")}
					</Text>

					<TextInput
						label={t("workingDirectory")}
						description={t("workingDirectoryHint")}
						placeholder={t("workingDirectoryPlaceholder")}
						leftSection={<IconFolder size={16} />}
						value={cwd}
						onChange={(e) => setCwd(e.currentTarget.value)}
						rightSection={
							cwd ? (
								isFavorited ? (
									<IconStarFilled
										size={16}
										style={{ color: "var(--mantine-color-yellow-5)" }}
									/>
								) : (
									<Tooltip label={t("addToFavorites")}>
										<ActionIcon
											variant="subtle"
											size="sm"
											onClick={() => addFavorite.mutate({ path: cwd })}
										>
											<IconStar size={16} />
										</ActionIcon>
									</Tooltip>
								)
							) : null
						}
					/>

					{favorites?.length ? (
						<Stack gap="xs">
							<Text size="xs" fw={500} c="dimmed">
								{t("favoriteDirectories")}
							</Text>
							{favorites.map((fav: any) => (
								<Group key={fav.id} gap="xs" wrap="nowrap">
									<Button
										variant={cwd === fav.path ? "light" : "subtle"}
										size="xs"
										style={{ flex: 1, justifyContent: "flex-start" }}
										onClick={() => setCwd(fav.path)}
									>
										<Text size="xs" truncate>
											{fav.label || fav.path}
										</Text>
									</Button>
									<ActionIcon
										variant="subtle"
										color="red"
										size="xs"
										onClick={() => removeFavorite.mutate(fav.id)}
									>
										<IconX size={14} />
									</ActionIcon>
								</Group>
							))}
						</Stack>
					) : null}

					<Button onClick={handleCreate} loading={createSession.isPending}>
						{t("createSession")}
					</Button>
				</Stack>
			</Modal>
		</Stack>
	);
}
