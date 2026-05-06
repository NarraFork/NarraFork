import {
	ActionIcon,
	Avatar,
	Badge,
	Button,
	Card,
	Checkbox,
	Group,
	Indicator,
	Loader,
	Modal,
	Popover,
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
	IconArchiveOff,
	IconBox,
	IconEye,
	IconFilter,
	IconPlayerPlay,
	IconSearch,
	IconSortAscending,
	IconSortDescending,
	IconTerminal2,
	IconTrash,
	IconX,
} from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserAvatar } from "../../components/UserAvatar";
import { useAllModels } from "../../hooks/useModels";
import {
	useDeleteNarrator,
	useNarratorsPaginated,
	useUnarchiveNarrator,
} from "../../hooks/useNarrator";
import { FOLLOW_DEFAULT_MODEL } from "../../lib/constants";
import { formatSmartTime } from "../../lib/format";
import { highlightSearchText, includesSearch, normalizeSearchText } from "../../lib/search-utils";

interface ArchivedNarratorSearchParams {
	sortBy?: string;
	sortOrder?: string;
	filter?: string;
	q?: string;
	hasTerminals?: boolean;
	hasContainers?: boolean;
	hasRunningContainers?: boolean;
	hasViewers?: boolean;
}

const parseBool = (v: unknown) => v === true || v === "true";

export const Route = createFileRoute("/narrators/archived")({
	component: ArchivedNarratorsPage,
	validateSearch: (search: Record<string, unknown>): ArchivedNarratorSearchParams => ({
		sortBy: typeof search.sortBy === "string" ? search.sortBy : undefined,
		sortOrder: typeof search.sortOrder === "string" ? search.sortOrder : undefined,
		filter: typeof search.filter === "string" ? search.filter : undefined,
		q: typeof search.q === "string" ? search.q : undefined,
		hasTerminals: parseBool(search.hasTerminals) || undefined,
		hasContainers: parseBool(search.hasContainers) || undefined,
		hasRunningContainers: parseBool(search.hasRunningContainers) || undefined,
		hasViewers: parseBool(search.hasViewers) || undefined,
	}),
});

function ArchivedNarratorsPage() {
	const search = Route.useSearch();
	const navigate = useNavigate();

	const sortBy = search.sortBy ?? "updatedAt";
	const sortOrder = search.sortOrder ?? "desc";
	const filter = search.filter ?? "all";
	const localQuery = search.q ?? "";
	const hasTerminals = search.hasTerminals ?? false;
	const hasContainers = search.hasContainers ?? false;
	const hasRunningContainers = search.hasRunningContainers ?? false;
	const hasViewers = search.hasViewers ?? false;

	const setSearch = useCallback(
		(patch: Partial<ArchivedNarratorSearchParams>) => {
			navigate({
				to: "/narrators/archived",
				search: (prev: ArchivedNarratorSearchParams) => {
					const next = { ...prev, ...patch };
					if (next.sortBy === "updatedAt") next.sortBy = undefined;
					if (next.sortOrder === "desc") next.sortOrder = undefined;
					if (next.filter === "all") next.filter = undefined;
					if (!next.q?.trim()) next.q = undefined;
					if (!next.hasTerminals) next.hasTerminals = undefined;
					if (!next.hasContainers) next.hasContainers = undefined;
					if (!next.hasRunningContainers) next.hasRunningContainers = undefined;
					if (!next.hasViewers) next.hasViewers = undefined;
					return next;
				},
				replace: true,
			});
		},
		[navigate],
	);

	const {
		data: paginatedData,
		isLoading,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useNarratorsPaginated({
		standalone: "all",
		status: "archived",
		filter: filter === "all" ? undefined : filter,
		sortBy,
		sortOrder,
		hasTerminals: hasTerminals || undefined,
		hasContainers: hasContainers || undefined,
		hasRunningContainers: hasRunningContainers || undefined,
		hasViewers: hasViewers || undefined,
	});
	const narrators = useMemo(
		() => paginatedData?.pages.flatMap((p) => p.items) ?? [],
		[paginatedData],
	);
	const unarchiveNarrator = useUnarchiveNarrator();
	const deleteNarrator = useDeleteNarrator();
	const { t } = useTranslation("narrators");
	const { t: tc } = useTranslation("common");
	const { defaultModelValue } = useAllModels();

	const [deleteOpened, { open: openDelete, close: closeDelete }] = useDisclosure(false);
	const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

	const handleDelete = useCallback(
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		(e: React.MouseEvent, narrator: any) => {
			e.preventDefault();
			e.stopPropagation();
			setDeleteTarget({
				id: narrator.id,
				title: narrator.title || narrator.id.slice(0, 8),
			});
			openDelete();
		},
		[openDelete],
	);

	const confirmDelete = useCallback(() => {
		if (!deleteTarget) return;
		deleteNarrator.mutate(deleteTarget.id, { onSuccess: closeDelete });
	}, [deleteTarget, deleteNarrator, closeDelete]);

	const sentinelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (localQuery.trim()) return;
		if (!sentinelRef.current || !hasNextPage) return;
		const observer = new IntersectionObserver(([entry]) => {
			if (entry.isIntersecting && !isFetchingNextPage) fetchNextPage();
		});
		observer.observe(sentinelRef.current);
		return () => observer.disconnect();
	}, [hasNextPage, isFetchingNextPage, fetchNextPage, localQuery]);

	const sortOptions = useMemo(
		() => [
			{ value: "updatedAt", label: t("sortUpdatedAt") },
			{ value: "createdAt", label: t("sortCreatedAt") },
			{ value: "title", label: t("sortTitle") },
			{ value: "messageCount", label: t("sortMessageCount") },
		],
		[t],
	);

	const activeFilterCount =
		(hasTerminals ? 1 : 0) +
		(hasContainers ? 1 : 0) +
		(hasRunningContainers ? 1 : 0) +
		(hasViewers ? 1 : 0);

	const filteredNarrators = useMemo(() => {
		const normalizedQuery = normalizeSearchText(localQuery);
		if (!normalizedQuery) return narrators;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		return narrators.filter((narrator: any) =>
			[
				narrator.title,
				narrator.id,
				narrator.cwd,
				narrator.model,
				narrator.status,
				narrator.chapter?.title,
				narrator.chapter?.projectName,
			]
				.filter(Boolean)
				.some((value) => includesSearch(value, localQuery)),
		);
	}, [narrators, localQuery]);

	const toggleSortOrder = () => setSearch({ sortOrder: sortOrder === "desc" ? "asc" : "desc" });

	const searchInput = (
		<TextInput
			size="xs"
			w={{ base: "100%", sm: 220 }}
			placeholder={t("localSearchPlaceholder")}
			value={localQuery}
			onChange={(e) => setSearch({ q: e.currentTarget.value || undefined })}
			leftSection={<IconSearch size={14} />}
			rightSection={
				localQuery ? (
					<ActionIcon size="xs" variant="subtle" onClick={() => setSearch({ q: undefined })}>
						<IconX size={12} />
					</ActionIcon>
				) : undefined
			}
		/>
	);

	const filterSegmentedControl = (
		<SegmentedControl
			size="xs"
			value={filter}
			onChange={(v) => setSearch({ filter: v })}
			data={[
				{ value: "all", label: t("filterAll") },
				{ value: "standalone", label: t("filterStandalone") },
				{ value: "chapter", label: t("filterChapter") },
			]}
		/>
	);

	const extraFiltersPopover = (
		<Popover width={220} position="bottom-end" shadow="md">
			<Popover.Target>
				<Indicator size={16} label={activeFilterCount} disabled={activeFilterCount === 0}>
					<ActionIcon variant="subtle" size="sm">
						<IconFilter size={16} />
					</ActionIcon>
				</Indicator>
			</Popover.Target>
			<Popover.Dropdown>
				<Stack gap="xs">
					<Text size="xs" fw={500} c="dimmed">
						{t("filterMenuTitle")}
					</Text>
					<Checkbox
						size="xs"
						label={
							<Group gap={6}>
								<IconTerminal2 size={14} />
								{t("filterHasTerminals")}
							</Group>
						}
						checked={hasTerminals}
						onChange={(e) => setSearch({ hasTerminals: e.currentTarget.checked })}
					/>
					<Checkbox
						size="xs"
						label={
							<Group gap={6}>
								<IconBox size={14} />
								{t("filterHasContainers")}
							</Group>
						}
						checked={hasContainers}
						onChange={(e) => setSearch({ hasContainers: e.currentTarget.checked })}
					/>
					<Checkbox
						size="xs"
						label={
							<Group gap={6}>
								<IconPlayerPlay size={14} />
								{t("filterHasRunningContainers")}
							</Group>
						}
						checked={hasRunningContainers}
						onChange={(e) => setSearch({ hasRunningContainers: e.currentTarget.checked })}
					/>
					<Checkbox
						size="xs"
						label={
							<Group gap={6}>
								<IconEye size={14} />
								{t("filterHasViewers")}
							</Group>
						}
						checked={hasViewers}
						onChange={(e) => setSearch({ hasViewers: e.currentTarget.checked })}
					/>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);

	const sortControls = (
		<Group gap="xs" wrap="nowrap">
			<Select
				size="xs"
				w={{ base: "100%", sm: 140 }}
				data={sortOptions}
				value={sortBy}
				onChange={(v) => v && setSearch({ sortBy: v })}
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
		</Group>
	);

	const renderLoadMoreToSearchButton = () => {
		if (!localQuery.trim() || !hasNextPage) return null;
		return (
			<Group justify="center" py="xs">
				<Button
					size="xs"
					variant="light"
					onClick={() => fetchNextPage()}
					loading={isFetchingNextPage}
				>
					{t("loadMoreToSearch")}
				</Button>
			</Group>
		);
	};

	return (
		<Stack>
			{/* Desktop header */}
			<Group justify="space-between" visibleFrom="sm">
				<Title order={2}>{t("archivedNarrators")}</Title>
				<Group gap="xs">
					{searchInput}
					{filterSegmentedControl}
					{extraFiltersPopover}
					{sortControls}
					<Button variant="subtle" component={Link} to="/narrators">
						{t("backToNarrators")}
					</Button>
				</Group>
			</Group>

			{/* Mobile header */}
			<Stack gap="xs" hiddenFrom="sm">
				<Group justify="space-between">
					<Title order={3}>{t("archivedNarrators")}</Title>
					<Group gap="xs">
						{extraFiltersPopover}
						<Button variant="subtle" size="xs" component={Link} to="/narrators">
							{t("backToNarrators")}
						</Button>
					</Group>
				</Group>
				{searchInput}
				{filterSegmentedControl}
				{sortControls}
			</Stack>

			{localQuery.trim() && narrators.length > 0 && (
				<Text size="xs" c="dimmed">
					{t("localSearchSummary", {
						shown: filteredNarrators.length,
						loaded: narrators.length,
					})}
				</Text>
			)}

			{isLoading ? (
				<Loader />
			) : !narrators.length ? (
				<Text c="dimmed">{t("noArchivedNarrators")}</Text>
			) : !filteredNarrators.length ? (
				<Stack>
					<Text c="dimmed">{t("localSearchNoResults")}</Text>
					{renderLoadMoreToSearchButton()}
				</Stack>
			) : (
				<Stack>
					{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
					{filteredNarrators.map((narrator: any) => {
						const viewers: Array<{
							userId: string;
							username: string;
							avatarColor: string | null;
							avatarImageId: string | null;
						}> = narrator.viewers ?? [];
						const activeTerminals: number = narrator.activeTerminalCount ?? 0;
						const containers: number = narrator.containerCount ?? 0;
						const runningContainers: number = narrator.runningContainerCount ?? 0;
						const chapter = narrator.chapter;
						return (
							<Link
								key={narrator.id}
								to="/narrators/$narratorId"
								params={{ narratorId: narrator.id }}
								style={{ textDecoration: "none", color: "inherit" }}
							>
								<Card shadow="sm" padding="md" withBorder>
									<Group justify="space-between" wrap="nowrap" align="flex-start">
										<Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
											<Group gap="xs" wrap="nowrap">
												<Text fw={500} truncate>
													{highlightSearchText(
														narrator.title || t("narratorId", { id: narrator.id.slice(0, 8) }),
														localQuery,
													)}
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
												{containers > 0 && (
													<Badge
														size="xs"
														variant="light"
														color={runningContainers > 0 ? "green" : "gray"}
														leftSection={<IconBox size={10} />}
													>
														{runningContainers}/{containers}
													</Badge>
												)}
											</Group>
											<Text size="sm" c="dimmed" truncate>
												{t("narratorMeta", {
													model:
														narrator.model === FOLLOW_DEFAULT_MODEL
															? t("followDefault", { model: defaultModelValue })
															: narrator.model,
													count: narrator.messageCount ?? 0,
												})}
											</Text>
											{(chapter?.projectName || narrator.cwd) && (
												<Text size="xs" c="dimmed" truncate>
													{[
														chapter?.projectName &&
															t("projectLabel", { name: chapter.projectName }),
														narrator.cwd && t("cwdLabel", { path: narrator.cwd }),
													]
														.filter(Boolean)
														.join(" · ")}
												</Text>
											)}
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
																	avatarImageId={v.avatarImageId}
																	userId={v.userId}
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
												<Text size="xs" c="dimmed">
													{t("createdAtLabel", { time: formatSmartTime(narrator.createdAt) })}
													{narrator.lastMessageAt &&
														` · ${t("lastMessageAtLabel", {
															time: formatSmartTime(narrator.lastMessageAt),
														})}`}
												</Text>
											</Group>
										</Stack>
										<Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
											<Tooltip label={t("unarchive")}>
												<ActionIcon
													size="sm"
													color="teal"
													variant="subtle"
													loading={unarchiveNarrator.isPending}
													onClick={(e) => {
														e.preventDefault();
														e.stopPropagation();
														unarchiveNarrator.mutate(narrator.id);
													}}
												>
													<IconArchiveOff size={16} />
												</ActionIcon>
											</Tooltip>
											<Tooltip label={t("deleteNarrator")}>
												<ActionIcon
													size="sm"
													color="red"
													variant="subtle"
													onClick={(e) => handleDelete(e, narrator)}
												>
													<IconTrash size={16} />
												</ActionIcon>
											</Tooltip>
										</Group>
									</Group>
								</Card>
							</Link>
						);
					})}
					{!localQuery.trim() && <div ref={sentinelRef} style={{ height: 1 }} />}
					{renderLoadMoreToSearchButton()}
					{isFetchingNextPage && !localQuery.trim() && (
						<Group justify="center" py="md">
							<Loader size="sm" />
							<Text size="sm" c="dimmed">
								{t("loadingMore")}
							</Text>
						</Group>
					)}
				</Stack>
			)}

			<Modal
				opened={deleteOpened}
				onClose={closeDelete}
				title={t("deleteNarratorConfirmTitle")}
				size="sm"
				centered
			>
				<Stack>
					<Text size="sm">{t("deleteNarratorConfirm", { name: deleteTarget?.title })}</Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={closeDelete}>
							{tc("cancel")}
						</Button>
						<Button color="red" onClick={confirmDelete} loading={deleteNarrator.isPending}>
							{t("deleteNarrator")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
