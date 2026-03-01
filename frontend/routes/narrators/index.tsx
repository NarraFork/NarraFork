import {
	ActionIcon,
	Avatar,
	Badge,
	Button,
	Card,
	Checkbox,
	Group,
	Loader,
	Modal,
	SegmentedControl,
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
	IconTerminal2,
	IconX,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "../../components/UserAvatar";
import {
	useCreateFavoriteDirectory,
	useDeleteFavoriteDirectory,
	useFavoriteDirectories,
} from "../../hooks/useFavoriteDirectories";
import { useAllModels } from "../../hooks/useModels";
import {
	useArchiveNarrator,
	useCreateNarrator,
	useNarratorsPaginated,
} from "../../hooks/useNarrator";
import { useNarratorsListWS } from "../../hooks/useNarratorWS";
import { addRecentTab } from "../../hooks/useRecentTabs";

import { NARRATOR_STATUS_COLORS } from "../../lib/constants";

export const Route = createFileRoute("/narrators/")({
	component: NarratorsPage,
	validateSearch: (search: Record<string, unknown>) => ({
		create: search.create === true || search.create === "true" || false,
	}),
});

function NarratorsPage() {
	const { create } = Route.useSearch();
	const [sortBy, setSortBy] = useState("updatedAt");
	const [sortOrder, setSortOrder] = useState("desc");
	const [filter, setFilter] = useState("all"); // "all" | "standalone" | "chapter"
	const {
		data: paginatedData,
		isLoading,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useNarratorsPaginated({
		standalone: "all",
		filter: filter === "all" ? undefined : filter,
		sortBy,
		sortOrder,
	});
	const narrators = useMemo(
		() => paginatedData?.pages.flatMap((p) => p.items) ?? [],
		[paginatedData],
	);
	const createNarrator = useCreateNarrator();
	const archiveNarrator = useArchiveNarrator();
	const [opened, { open, close }] = useDisclosure(false);
	const { t } = useTranslation("narrators");
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

	// Auto-open create modal when navigated with ?create=true
	useEffect(() => {
		if (create) {
			open();
			navigate({ to: "/narrators", search: { create: false }, replace: true });
		}
	}, [create, open, navigate]);

	const { groupedModels, settingsData } = useAllModels();

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const narratorIds = useMemo(() => narrators.map((s: any) => s.id), [narrators]);
	useNarratorsListWS(narratorIds, (narratorId, event) => {
		if (!narratorId) {
			qc.invalidateQueries({ queryKey: ["narrators"] });
			return;
		}
		qc.setQueryData(
			[
				"narrators",
				"paginated",
				{
					standalone: "all",
					filter: filter === "all" ? undefined : filter,
					sortBy,
					sortOrder,
				},
			],
			// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
			(old: any) => {
				if (!old?.pages) return old;
				let changed = false;
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				const pages = old.pages.map((page: any) => ({
					...page,
					// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
					items: page.items.map((item: any) => {
						if (item.id !== narratorId) return item;
						changed = true;
						return {
							...item,
							...(event.status !== undefined ? { status: event.status } : {}),
							...(event.title !== undefined ? { title: event.title } : {}),
							...(event.planMode !== undefined ? { planMode: event.planMode } : {}),
							...(event.viewers !== undefined ? { viewers: event.viewers } : {}),
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

	const handleNarratorClick = useCallback(
		(narratorId: string) => {
			if (navigatingId) return;
			setNavigatingId(narratorId);
			navigate({ to: "/narrators/$narratorId", params: { narratorId } });
		},
		[navigate, navigatingId],
	);

	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	const isFavorited = favorites?.some((f: any) => f.path === cwd);

	const handleCreate = () => {
		createNarrator.mutate(
			{
				...(cwd ? { cwd } : {}),
				...(selectedModel ? { model: selectedModel } : {}),
				...(planMode ? { planMode: true } : {}),
			},
			{
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				onSuccess: (data: any) => {
					close();
					setCwd("");
					setSelectedModel("");
					setPlanMode(false);
					addRecentTab({
						type: "narrator",
						id: data.id,
						title: data.title || t("newNarrator"),
						subtitle: data.cwd || cwd,
						status: data.status || "idle",
					});
					navigate({ to: "/narrators/$narratorId", params: { narratorId: data.id } });
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
					<SegmentedControl
						size="xs"
						value={filter}
						onChange={setFilter}
						data={[
							{ value: "all", label: t("filterAll") },
							{ value: "standalone", label: t("filterStandalone") },
							{ value: "chapter", label: t("filterChapter") },
						]}
					/>
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
					<Button variant="subtle" component={Link} to="/narrators/archived">
						{t("viewArchived")}
					</Button>
					<Button onClick={open}>{t("newNarrator")}</Button>
				</Group>
			</Group>

			{/* Mobile header */}
			<Stack gap="xs" hiddenFrom="sm">
				<Group justify="space-between">
					<Title order={3}>{t("title")}</Title>
					<Button size="xs" onClick={open}>
						{t("newNarrator")}
					</Button>
				</Group>
				<SegmentedControl
					size="xs"
					fullWidth
					value={filter}
					onChange={setFilter}
					data={[
						{ value: "all", label: t("filterAll") },
						{ value: "standalone", label: t("filterStandalone") },
						{ value: "chapter", label: t("filterChapter") },
					]}
				/>
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
					<Button variant="subtle" size="xs" component={Link} to="/narrators/archived">
						{t("viewArchived")}
					</Button>
				</Group>
			</Stack>

			{isLoading ? (
				<Loader />
			) : !narrators.length ? (
				<Text c="dimmed">{t("noNarrators")}</Text>
			) : (
				<Stack>
					{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
					{narrators.map((narrator: any) => {
						const isNavigating = navigatingId === narrator.id;
						const viewers: Array<{
							userId: string;
							username: string;
							avatarColor: string | null;
						}> = narrator.viewers ?? [];
						const activeTerminals: number = narrator.activeTerminalCount ?? 0;
						const chapter = narrator.chapter;
						return (
							<Card
								key={narrator.id}
								shadow="sm"
								padding="md"
								withBorder
								style={{
									cursor: "pointer",
									transition: "transform 80ms ease, opacity 150ms ease",
									opacity: navigatingId && !isNavigating ? 0.5 : 1,
									WebkitTapHighlightColor: "transparent",
								}}
								onClick={() => handleNarratorClick(narrator.id)}
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
								<Group justify="space-between" wrap="nowrap">
									<div style={{ flex: 1, minWidth: 0 }}>
										<Group gap="xs" wrap="wrap">
											<Text fw={500}>
												{narrator.title || t("narratorId", { id: narrator.id.slice(0, 8) })}
											</Text>
											{narrator.status === "thinking" && (
												<Loader size={14} color={narrator.planMode ? "green" : undefined} />
											)}
											{narrator.status === "thinking" && narrator.planMode && (
												<Badge size="xs" color="green">
													{tn("status_planning")}
												</Badge>
											)}
											{narrator.status &&
												narrator.status !== "idle" &&
												narrator.status !== "thinking" && (
													<Badge
														size="xs"
														color={NARRATOR_STATUS_COLORS[narrator.status] ?? "gray"}
													>
														{tn(`status_${narrator.status}`)}
													</Badge>
												)}
											{chapter && (
												<Badge size="xs" variant="outline" color="indigo">
													{chapter.title}
												</Badge>
											)}
										</Group>
										<Group gap="xs">
											<Text size="sm" c="dimmed">
												{t("narratorMeta", {
													model: narrator.model,
													count: narrator.messageCount ?? 0,
												})}
											</Text>
											{activeTerminals > 0 && (
												<Badge
													size="xs"
													variant="light"
													color="teal"
													leftSection={<IconTerminal2 size={10} />}
												>
													{activeTerminals}
												</Badge>
											)}
										</Group>
										{chapter?.projectName && (
											<Text size="xs" c="dimmed" truncate>
												{t("projectLabel", { name: chapter.projectName })}
											</Text>
										)}
										{narrator.cwd && (
											<Text size="xs" c="dimmed" truncate>
												{t("cwdLabel", { path: narrator.cwd })}
											</Text>
										)}
									</div>
									<Group gap="xs" wrap="nowrap">
										{viewers.length > 0 && (
											<Tooltip
												label={`${t("viewingNow")}: ${viewers.map((v) => v.username).join(", ")}`}
											>
												<Avatar.Group spacing="xs">
													{viewers.slice(0, 3).map((v) => (
														<UserAvatar
															key={v.userId}
															username={v.username}
															avatarColor={v.avatarColor}
															size="sm"
															showTooltip={false}
														/>
													))}
													{viewers.length > 3 && (
														<Avatar size="sm" radius="xl">
															+{viewers.length - 3}
														</Avatar>
													)}
												</Avatar.Group>
											</Tooltip>
										)}
										<Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
											{new Date(
												sortBy === "updatedAt" ? narrator.updatedAt : narrator.createdAt,
											).toLocaleDateString(i18n.language)}
										</Text>
										<Tooltip label={t("archive")}>
											<ActionIcon
												size="sm"
												color="orange"
												variant="subtle"
												onClick={(e: React.MouseEvent) => {
													e.stopPropagation();
													setConfirmArchiveId(narrator.id);
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

			<Modal opened={opened} onClose={handleClose} title={t("newNarratorModal")}>
				<Stack>
					<Text size="sm" c="dimmed">
						{t("newNarratorDescription")}
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
							{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
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
						data={groupedModels}
						searchable
						value={selectedModel || null}
						onChange={(v) => setSelectedModel(v ?? "")}
						placeholder={settingsData?.agent?.defaultModel ?? "claude-sonnet"}
						clearable
						maxDropdownHeight={320}
						comboboxProps={{ withinPortal: true, position: "bottom-start", zIndex: 320 }}
					/>

					<Checkbox
						label={t("startInPlanMode")}
						description={t("startInPlanModeHint")}
						checked={planMode}
						onChange={(e) => setPlanMode(e.currentTarget.checked)}
					/>

					<Button onClick={handleCreate} loading={createNarrator.isPending}>
						{t("createNarrator")}
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
									archiveNarrator.mutate(confirmArchiveId);
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
