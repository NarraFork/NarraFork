import { MobileNavButton } from "@frontend/components/nav/MobileNavButton";
import { Button, Group, Loader, Modal, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	CreateNarratorLazyModal,
	preloadCreateNarratorModal,
} from "../../components/narrator/CreateNarratorLazyModal";
import type { CreateNarratorResult } from "../../components/narrator/CreateNarratorModal";
import {
	NarratorListCard,
	type NarratorListItem,
} from "../../components/narrator/list/NarratorListCard";
import {
	NarratorListControls,
	NarratorListExtraFiltersButton,
	NarratorListLoadMoreButton,
	NarratorListLocalSearchSummary,
} from "../../components/narrator/list/NarratorListControls";
import {
	applyNarratorListEvent,
	buildNarratorListQueryOptions,
	filterNarratorsByLocalQuery,
	getNarratorListState,
	matchesNarratorSearch,
	type NarratorListSearchParams,
	type NarratorsInfiniteData,
	NO_EXPANDED_IDS,
	normalizeNarratorListSearchPatch,
	parseBool,
	useNarratorInfiniteScroll,
	validateNarratorListSearch,
} from "../../components/narrator/list/narrator-list-utils";
import { useAllModels } from "../../hooks/useModels";
import { useArchiveNarrator, useNarratorsPaginated } from "../../hooks/useNarrator";
import { useNarratorsListWS } from "../../hooks/useNarratorWS";
import { addRecentTab } from "../../hooks/useRecentTabs";
import { useSetupWizardGuard } from "../../hooks/useSetupWizardGuard";

const importImportSessionModal = () =>
	import("../../components/narrator/session-interchange/ImportSessionModal");
const ImportSessionModal = lazy(() =>
	importImportSessionModal().then((m) => ({ default: m.ImportSessionModal })),
);

function preloadImportSessionModal(): void {
	void importImportSessionModal().catch(() => {});
}

interface NarratorSearchParams extends NarratorListSearchParams {
	create?: boolean;
}

export const Route = createFileRoute("/narrators/")({
	component: NarratorsPage,
	validateSearch: (search: Record<string, unknown>): NarratorSearchParams => ({
		...validateNarratorListSearch(search),
		create: parseBool(search.create) || undefined,
	}),
});

function NarratorsPage() {
	const search = Route.useSearch();
	const navigate = useNavigate();
	const listState = useMemo(() => getNarratorListState(search), [search]);
	const { localQuery } = listState;

	// Helper to update search params while preserving others
	const setSearch = useCallback(
		(patch: Partial<NarratorSearchParams>) => {
			navigate({
				to: "/narrators",
				search: (prev: NarratorSearchParams) => {
					const next = normalizeNarratorListSearchPatch(prev, patch);
					if (!next.create) next.create = undefined;
					return next;
				},
				replace: true,
			});
		},
		[navigate],
	);

	const queryOptions = useMemo(() => buildNarratorListQueryOptions(listState), [listState]);
	const {
		data: paginatedData,
		isLoading,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useNarratorsPaginated(queryOptions);
	const narrators = useMemo(
		() => (paginatedData?.pages.flatMap((p) => p.items) ?? []) as NarratorListItem[],
		[paginatedData],
	);
	const archiveNarrator = useArchiveNarrator();
	const [opened, { open, close }] = useDisclosure(false);
	const [importOpened, { open: openImport, close: closeImport }] = useDisclosure(false);
	const { t } = useTranslation("narrators");
	const { t: tn } = useTranslation("narrator");
	const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
	// 哪个主会话的顺便提问子会话是展开的。放在页面上而不是卡片里，重新取数后不丢。
	const [expandedAskInPassing, setExpandedAskInPassing] = useState<Set<string>>(() => new Set());
	const [navigatingId, setNavigatingId] = useState<string | null>(null);
	const qc = useQueryClient();
	const requireSetup = useSetupWizardGuard();

	const guardedOpen = useCallback(() => {
		if (!requireSetup()) return;
		open();
	}, [requireSetup, open]);

	// Auto-open create modal when navigated with ?create=true
	useEffect(() => {
		if (search.create) {
			guardedOpen();
			setSearch({ create: undefined });
		}
	}, [search.create, guardedOpen, setSearch]);

	const { defaultModelValue } = useAllModels();

	// 顺便提问子会话也订阅：它们的状态变化同样会到达这张列表，只是挂在父项下面。
	const narratorIds = useMemo(
		() => narrators.flatMap((s) => [s.id, ...(s.askInPassingSessions ?? []).map((c) => c.id)]),
		[narrators],
	);
	useNarratorsListWS(narratorIds, (narratorId, event) => {
		if (!narratorId) {
			qc.invalidateQueries({ queryKey: ["narrators"] });
			return;
		}
		qc.setQueryData<NarratorsInfiniteData>(["narrators", "paginated", queryOptions], (old) =>
			applyNarratorListEvent(old, narratorId, event),
		);
	});

	// Infinite scroll sentinel
	const sentinelRef = useNarratorInfiniteScroll({
		disabled: !!localQuery.trim(),
		hasNextPage,
		isFetchingNextPage,
		fetchNextPage,
	});

	const filteredNarrators = useMemo(
		() => filterNarratorsByLocalQuery(narrators, localQuery),
		[narrators, localQuery],
	);

	const toggleAskInPassing = useCallback((narratorId: string) => {
		setExpandedAskInPassing((prev) => {
			const next = new Set(prev);
			if (next.has(narratorId)) next.delete(narratorId);
			else next.add(narratorId);
			return next;
		});
	}, []);

	// 搜索命中在子会话里时把主会话展开：否则列表里会出现一条自己看不出为什么在这的行。
	const expandedBySearch = useMemo(() => {
		if (!localQuery.trim()) return NO_EXPANDED_IDS;
		return new Set(
			filteredNarrators
				.filter((narrator) => !matchesNarratorSearch(narrator, localQuery))
				.map((narrator) => narrator.id),
		);
	}, [filteredNarrators, localQuery]);

	// 归档确认里先说清会连带多少条顺便提问，免得用户以为只收走了一条。
	const hasLinkedQuestions = !!narrators.find((narrator) => narrator.id === confirmArchiveId)
		?.askInPassingSessions?.length;

	const handleNarratorClick = useCallback(
		(narratorId: string) => {
			if (navigatingId) return;
			setNavigatingId(narratorId);
			navigate({ to: "/narrators/$narratorId", params: { narratorId } });
		},
		[navigate, navigatingId],
	);

	const handleCreated = useCallback(
		(data: CreateNarratorResult) => {
			addRecentTab({
				type: "narrator",
				id: data.id,
				title: data.title,
				subtitle: data.cwd,
				status: data.status,
			});
			navigate({ to: "/narrators/$narratorId", params: { narratorId: data.id } });
		},
		[navigate],
	);

	const handleImported = useCallback(
		(data: { narratorId: string; title: string }) => {
			addRecentTab({ type: "narrator", id: data.narratorId, title: data.title });
			navigate({ to: "/narrators/$narratorId", params: { narratorId: data.narratorId } });
		},
		[navigate],
	);

	return (
		<Stack>
			{/* Desktop header */}
			<Group justify="space-between" visibleFrom="sm">
				<Title order={2}>{t("title")}</Title>
				<Group gap="xs">
					<NarratorListControls state={listState} onChange={setSearch} includeExtraFilters />
					<Button variant="subtle" component={Link} to="/narrators/archived">
						{t("viewArchived")}
					</Button>
					<Button
						variant="default"
						onPointerEnter={preloadImportSessionModal}
						onFocus={preloadImportSessionModal}
						onPointerDown={preloadImportSessionModal}
						onClick={openImport}
					>
						{t("sessionInterchange.importButton")}
					</Button>
					<Button
						onPointerEnter={preloadCreateNarratorModal}
						onFocus={preloadCreateNarratorModal}
						onPointerDown={preloadCreateNarratorModal}
						onClick={guardedOpen}
					>
						{t("newNarrator")}
					</Button>
				</Group>
			</Group>

			{/* Mobile header */}
			<Stack gap="xs" hiddenFrom="sm">
				<Group justify="space-between">
					<Group gap="xs" wrap="nowrap">
						<MobileNavButton />
						<Title order={3}>{t("title")}</Title>
					</Group>
					<Group gap="xs">
						<NarratorListExtraFiltersButton state={listState} onChange={setSearch} />
						<Button
							size="xs"
							variant="default"
							onPointerEnter={preloadImportSessionModal}
							onFocus={preloadImportSessionModal}
							onPointerDown={preloadImportSessionModal}
							onClick={openImport}
						>
							{t("sessionInterchange.importButton")}
						</Button>
						<Button
							size="xs"
							onPointerEnter={preloadCreateNarratorModal}
							onFocus={preloadCreateNarratorModal}
							onPointerDown={preloadCreateNarratorModal}
							onClick={guardedOpen}
						>
							{t("newNarrator")}
						</Button>
					</Group>
				</Group>
				<NarratorListControls
					state={listState}
					onChange={setSearch}
					layout="mobile"
					sortAction={
						<Button variant="subtle" size="xs" component={Link} to="/narrators/archived">
							{t("viewArchived")}
						</Button>
					}
				/>
			</Stack>

			<NarratorListLocalSearchSummary
				localQuery={localQuery}
				shown={filteredNarrators.length}
				loaded={narrators.length}
			/>

			{isLoading ? (
				<Loader />
			) : !narrators.length ? (
				<Text c="dimmed">{t("noNarrators")}</Text>
			) : !filteredNarrators.length ? (
				<Stack>
					<Text c="dimmed">{t("localSearchNoResults")}</Text>
					<NarratorListLoadMoreButton
						localQuery={localQuery}
						hasNextPage={hasNextPage}
						isFetchingNextPage={isFetchingNextPage}
						fetchNextPage={fetchNextPage}
					/>
				</Stack>
			) : (
				<Stack>
					{filteredNarrators.map((narrator) => (
						<NarratorListCard
							key={narrator.id}
							variant="active"
							narrator={narrator}
							localQuery={localQuery}
							defaultModelValue={defaultModelValue}
							dimmed={!!navigatingId && navigatingId !== narrator.id}
							onOpen={handleNarratorClick}
							onArchive={setConfirmArchiveId}
							askInPassingExpanded={
								expandedAskInPassing.has(narrator.id) || expandedBySearch.has(narrator.id)
							}
							onToggleAskInPassing={toggleAskInPassing}
							onOpenAskInPassing={handleNarratorClick}
						/>
					))}
					{!localQuery.trim() && <div ref={sentinelRef} style={{ height: 1 }} />}
					<NarratorListLoadMoreButton
						localQuery={localQuery}
						hasNextPage={hasNextPage}
						isFetchingNextPage={isFetchingNextPage}
						fetchNextPage={fetchNextPage}
					/>
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

			<CreateNarratorLazyModal opened={opened} onClose={close} onCreated={handleCreated} />

			{importOpened && (
				<Suspense fallback={null}>
					<ImportSessionModal
						opened={importOpened}
						onClose={closeImport}
						onImported={handleImported}
					/>
				</Suspense>
			)}

			<Modal
				opened={!!confirmArchiveId}
				onClose={() => {
					if (!archiveNarrator.isPending) setConfirmArchiveId(null);
				}}
				title={tn("archiveConfirmTitle")}
				centered
			>
				<Stack>
					<Text size="sm">{tn("archiveActiveWarning")}</Text>
					{hasLinkedQuestions && (
						<Text size="sm" c="dimmed">
							{tn("archiveAskInPassingWarning")}
						</Text>
					)}
					<Group justify="flex-end">
						<Button
							variant="default"
							disabled={archiveNarrator.isPending}
							onClick={() => setConfirmArchiveId(null)}
						>
							{tn("cancel")}
						</Button>
						<Button
							color="orange"
							loading={archiveNarrator.isPending}
							onClick={() => {
								if (confirmArchiveId) {
									archiveNarrator.mutate(confirmArchiveId, {
										onSuccess: () => setConfirmArchiveId(null),
									});
								}
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
