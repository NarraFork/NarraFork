import {
	ActionIcon,
	Badge,
	Button,
	Card,
	Checkbox,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useCreateFavoriteDirectory,
	useDeleteFavoriteDirectory,
	useFavoriteDirectories,
} from "../../hooks/useFavoriteDirectories";
import {
	useArchiveNarrator,
	useCreateNarrator,
	useNarratorsPaginated,
} from "../../hooks/useNarrator";
import { useSessionsListWS } from "../../hooks/useNarratorWS";
import { api } from "../../lib/api";
import {
	BUILTIN_MODELS,
	groupModelsByProvider,
	type ModelOption,
	NARRATOR_STATUS_COLORS,
} from "../../lib/constants";

export const Route = createFileRoute("/sessions/")({
	component: SessionsPage,
});

function SessionsPage() {
	const [sortBy, setSortBy] = useState("updatedAt");
	const [sortOrder, setSortOrder] = useState("desc");
	const {
		data: paginatedData,
		isLoading,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useNarratorsPaginated({ standalone: true, sortBy, sortOrder });
	const sessions = useMemo(
		() => paginatedData?.pages.flatMap((p) => p.items) ?? [],
		[paginatedData],
	);
	const createSession = useCreateNarrator();
	const archiveSession = useArchiveNarrator();
	const [opened, { open, close }] = useDisclosure(false);
	const { t } = useTranslation("sessions");
	const { t: tc } = useTranslation("common");
	const { t: tn } = useTranslation("narrator");
	const { i18n } = useTranslation();
	const [cwd, setCwd] = useState("");
	const [selectedModel, setSelectedModel] = useState("");
	const [planMode, setPlanMode] = useState(false);
	const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
	const [navigatingId, setNavigatingId] = useState<string | null>(null);
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
		const hidden: string[] = settingsData?.agent?.hiddenModels ?? [];
					.map((m: any) => ({
						value: String(m.model_id ?? m.modelId ?? ""),
						label: String(
							m.model_short_name ??
								m.modelShortName ??
								m.model_name ??
								m.modelName ??
								m.model_id ??
								m.modelId ??
								"",
						),
						rateMultiplier: m.rate_multiplier ?? m.rateMultiplier,
					}))
					.filter((m: ModelOption) => m.value)
			: BUILTIN_MODELS.map((m) => ({
					...m,
				}));
		const custom = (customModels ?? []).map(
			(m: { value: string; label: string; provider?: string }) => ({
				...m,
				provider: m.provider ?? "openai",
			}),
		);

	const sessionIds = useMemo(() => sessions.map((s: any) => s.id), [sessions]);
	useSessionsListWS(sessionIds, (narratorId, event) => {
		if (!narratorId) {
			// Fallback: no narratorId in event, invalidate all
			qc.invalidateQueries({ queryKey: ["narrators"] });
			return;
		}
		// Targeted update of the specific session in paginated cache
		qc.setQueryData(
			["narrators", "paginated", { standalone: true, sortBy, sortOrder }],
			(old: any) => {
				if (!old?.pages) return old;
				let changed = false;
				const pages = old.pages.map((page: any) => ({
					...page,
					items: page.items.map((item: any) => {
						if (item.id !== narratorId) return item;
						changed = true;
						return {
							...item,
							...(event.status !== undefined ? { status: event.status } : {}),
							...(event.title !== undefined ? { title: event.title } : {}),
							...(event.sdkPlanMode !== undefined ? { sdkPlanMode: event.sdkPlanMode } : {}),
							updatedAt: new Date().toISOString(),
						};
					}),
				}));
				return changed ? { ...old, pages } : old;
			},
		);
	});

	// Infinite scroll sentinel
	const sentinelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!sentinelRef.current || !hasNextPage) return;
		const observer = new IntersectionObserver(([entry]) => {
			if (entry.isIntersecting && !isFetchingNextPage) fetchNextPage();
		});
		observer.observe(sentinelRef.current);
		return () => observer.disconnect();
	}, [hasNextPage, isFetchingNextPage, fetchNextPage]);

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

	const handleSessionClick = useCallback(
		(sessionId: string) => {
			if (navigatingId) return;
			setNavigatingId(sessionId);
			navigate({ to: "/sessions/$sessionId", params: { sessionId } });
		},
		[navigate, navigatingId],
	);

	const isFavorited = favorites?.some((f: any) => f.path === cwd);

	const handleCreate = () => {
		createSession.mutate(
			{
				...(cwd ? { cwd } : {}),
				...(selectedModel ? { model: selectedModel } : {}),
				...(planMode ? { sdkPlanMode: true } : {}),
			},
			{
				onSuccess: (data: any) => {
					close();
					setCwd("");
					setSelectedModel("");
					setPlanMode(false);
					navigate({ to: "/sessions/$sessionId", params: { sessionId: data.id } });
				},
			},
		);
	};

	const handleClose = () => {
		close();
		setCwd("");
		setSelectedModel("");
		setPlanMode(false);
	};

	return (
		<Stack>
			{/* Desktop header */}
			<Group justify="space-between" visibleFrom="sm">
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

			{/* Mobile header */}
			<Stack gap="xs" hiddenFrom="sm">
				<Group justify="space-between">
					<Title order={3}>{t("title")}</Title>
					<Button size="xs" onClick={open}>
						{t("newSession")}
					</Button>
				</Group>
				<Group gap="xs">
					<Select
						size="xs"
						style={{ flex: 1 }}
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
					<Button variant="subtle" size="xs" component={Link} to="/sessions/archived">
						{t("viewArchived")}
					</Button>
				</Group>
			</Stack>

			{isLoading ? (
				<Loader />
			) : !sessions.length ? (
				<Text c="dimmed">{t("noSessions")}</Text>
			) : (
				<Stack>
					{sessions.map((session: any) => {
						const isNavigating = navigatingId === session.id;
						return (
							<Card
								key={session.id}
								shadow="sm"
								padding="md"
								withBorder
								style={{
									cursor: "pointer",
									transition: "transform 80ms ease, opacity 150ms ease",
									opacity: navigatingId && !isNavigating ? 0.5 : 1,
									WebkitTapHighlightColor: "transparent",
								}}
								onClick={() => handleSessionClick(session.id)}
								onPointerDown={(e: React.PointerEvent<HTMLDivElement>) => {
									e.currentTarget.style.transform = "scale(0.985)";
								}}
								onPointerUp={(e: React.PointerEvent<HTMLDivElement>) => {
									e.currentTarget.style.transform = "";
								}}
								onPointerLeave={(e: React.PointerEvent<HTMLDivElement>) => {
									e.currentTarget.style.transform = "";
								}}
							>
								<Group justify="space-between">
									<div style={{ flex: 1, minWidth: 0 }}>
										<div>
											<Group gap="xs">
												<Text fw={500}>
													{session.title || t("sessionId", { id: session.id.slice(0, 8) })}
												</Text>
												{session.status === "thinking" && (
													<Loader size={14} color={session.sdkPlanMode ? "green" : undefined} />
												)}
												{session.status === "thinking" && session.sdkPlanMode && (
													<Badge size="xs" color="green">
														{tn("status_planning")}
													</Badge>
												)}
												{session.status &&
													session.status !== "idle" &&
													session.status !== "thinking" && (
														<Badge
															size="xs"
															color={NARRATOR_STATUS_COLORS[session.status] ?? "gray"}
														>
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
									</div>
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
												onClick={(e: React.MouseEvent) => {
													e.stopPropagation();
													setConfirmArchiveId(session.id);
												}}
											>
												<IconArchive size={16} />
											</ActionIcon>
										</Tooltip>
									</Group>
								</Group>
							</Card>
						);
					})}
					<div ref={sentinelRef} style={{ height: 1 }} />
					{isFetchingNextPage && (
						<Group justify="center" py="md">
							<Loader size="sm" />
							<Text size="sm" c="dimmed">
								{t("loadingMore")}
							</Text>
						</Group>
					)}
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
						data={groupModelsByProvider(allModels)}
						searchable
						value={selectedModel || null}
						onChange={(v) => setSelectedModel(v ?? "")}
						placeholder={settingsData?.agent?.defaultModel ?? "claude-sonnet"}
						clearable
					/>

					<Checkbox
						label={t("startInPlanMode")}
						description={t("startInPlanModeHint")}
						checked={planMode}
						onChange={(e) => setPlanMode(e.currentTarget.checked)}
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
