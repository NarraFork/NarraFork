import {
	ActionIcon,
	Badge,
	Button,
	Card,
	Group,
	Loader,
	Modal,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconArchive,
	IconFolder,
	IconSortAscending,
	IconSortDescending,
	IconStar,
	IconStarFilled,
	IconX,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCreateFavoriteDirectory,
	useDeleteFavoriteDirectory,
	useFavoriteDirectories,
} from "../../hooks/useFavoriteDirectories";
import { useArchiveNarrator, useCreateNarrator, useNarrators } from "../../hooks/useNarrator";
import { useSessionsListWS } from "../../hooks/useNarratorWS";
import { api } from "../../lib/api";
import { BUILTIN_MODELS, NARRATOR_STATUS_COLORS } from "../../lib/constants";

export const Route = createFileRoute("/sessions/")({
	component: SessionsPage,
});

function SessionsPage() {
	const [sortBy, setSortBy] = useState("updatedAt");
	const [sortOrder, setSortOrder] = useState("desc");
	const { data: sessions, isLoading } = useNarrators({ standalone: true, sortBy, sortOrder });
	const createSession = useCreateNarrator();
	const archiveSession = useArchiveNarrator();
	const [opened, { open, close }] = useDisclosure(false);
	const { t } = useTranslation("sessions");
	const { t: tc } = useTranslation("common");
	const { t: tn } = useTranslation("narrator");
	const { i18n } = useTranslation();
	const [cwd, setCwd] = useState("");
	const [selectedModel, setSelectedModel] = useState("");
	const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
	const { data: favorites } = useFavoriteDirectories();
	const addFavorite = useCreateFavoriteDirectory();
	const removeFavorite = useDeleteFavoriteDirectory();
	const qc = useQueryClient();
	const navigate = useNavigate();

	const { data: settingsData } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
	});
	const customModels = settingsData?.agent?.customModels;
	const allModels = useMemo(() => {
		return [...BUILTIN_MODELS, ...(customModels ?? [])];
	}, [customModels]);

	const sessionIds = useMemo(() => (sessions ?? []).map((s: any) => s.id), [sessions]);
	useSessionsListWS(sessionIds, () => {
		qc.invalidateQueries({ queryKey: ["narrators"] });
	});

	const sortOptions = useMemo(
		() => [
			{ value: "updatedAt", label: t("sortUpdatedAt") },
			{ value: "createdAt", label: t("sortCreatedAt") },
			{ value: "title", label: t("sortTitle") },
			{ value: "messageCount", label: t("sortMessageCount") },
		],
		[t],
	);

	const toggleSortOrder = () => setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"));

	const isFavorited = favorites?.some((f: any) => f.path === cwd);

	const handleCreate = () => {
		createSession.mutate(
			{
				...(cwd ? { cwd } : {}),
				...(selectedModel ? { model: selectedModel } : {}),
			},
			{
				onSuccess: (data: any) => {
					close();
					setCwd("");
					setSelectedModel("");
					navigate({ to: "/sessions/$sessionId", params: { sessionId: data.id } });
				},
			},
		);
	};

	const handleClose = () => {
		close();
		setCwd("");
		setSelectedModel("");
	};

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>{t("title")}</Title>
				<Group gap="xs">
					<Select
						size="xs"
						w={140}
						data={sortOptions}
						value={sortBy}
						onChange={(v) => v && setSortBy(v)}
						allowDeselect={false}
					/>
					<Tooltip label={sortOrder === "desc" ? t("sortDescending") : t("sortAscending")}>
						<ActionIcon variant="subtle" size="sm" onClick={toggleSortOrder}>
							{sortOrder === "desc" ? (
								<IconSortDescending size={16} />
							) : (
								<IconSortAscending size={16} />
							)}
						</ActionIcon>
					</Tooltip>
					<Button variant="subtle" component={Link} to="/sessions/archived">
						{t("viewArchived")}
					</Button>
					<Button onClick={open}>{t("newSession")}</Button>
				</Group>
			</Group>

			{isLoading ? (
				<Loader />
			) : !sessions?.length ? (
				<Text c="dimmed">{t("noSessions")}</Text>
			) : (
				<Stack>
					{sessions.map((session: any) => (
						<Card key={session.id} shadow="sm" padding="md" withBorder>
							<Group justify="space-between">
								<Link
									to="/sessions/$sessionId"
									params={{ sessionId: session.id }}
									style={{ textDecoration: "none", color: "inherit", flex: 1, minWidth: 0 }}
								>
									<div>
										<Group gap="xs">
											<Text fw={500}>
												{session.title || t("sessionId", { id: session.id.slice(0, 8) })}
											</Text>
											{session.status === "thinking" && <Loader size={14} />}
											{session.status &&
												session.status !== "idle" &&
												session.status !== "thinking" && (
													<Badge size="xs" color={NARRATOR_STATUS_COLORS[session.status] ?? "gray"}>
														{tn(`status_${session.status}`)}
													</Badge>
												)}
										</Group>
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
								</Link>
								<Group>
									<Text size="xs" c="dimmed">
										{new Date(
											sortBy === "updatedAt" ? session.updatedAt : session.createdAt,
										).toLocaleDateString(i18n.language)}
									</Text>
									<Tooltip label={t("archive")}>
										<ActionIcon
											size="sm"
											color="orange"
											variant="subtle"
											onClick={() => setConfirmArchiveId(session.id)}
										>
											<IconArchive size={16} />
										</ActionIcon>
									</Tooltip>
								</Group>
							</Group>
						</Card>
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
									<IconStarFilled size={16} style={{ color: "var(--mantine-color-yellow-5)" }} />
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

					<Select
						label={t("model")}
						description={t("modelHint")}
						data={allModels}
						searchable
						value={selectedModel || null}
						onChange={(v) => setSelectedModel(v ?? "")}
						placeholder={settingsData?.agent?.defaultModel ?? "claude-sonnet"}
						clearable
					/>

					<Button onClick={handleCreate} loading={createSession.isPending}>
						{t("createSession")}
					</Button>
				</Stack>
			</Modal>

			<Modal
				opened={!!confirmArchiveId}
				onClose={() => setConfirmArchiveId(null)}
				title={tn("archiveConfirmTitle")}
				centered
			>
				<Stack>
					<Text size="sm">{tn("archiveActiveWarning")}</Text>
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setConfirmArchiveId(null)}>
							{tn("cancel")}
						</Button>
						<Button
							color="orange"
							onClick={() => {
								if (confirmArchiveId) {
									archiveSession.mutate(confirmArchiveId);
								}
								setConfirmArchiveId(null);
							}}
						>
							{tn("confirmArchive")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
