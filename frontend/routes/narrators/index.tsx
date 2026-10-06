import { Button, Group, Loader, Modal, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
	buildNarratorListQueryOptions,
	filterNarratorsByLocalQuery,
	getNarratorListState,
	type NarratorListSearchParams,
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

const CreateNarratorModal = lazy(() =>
	import("../../components/narrator/CreateNarratorModal").then((m) => ({
		default: m.CreateNarratorModal,
	})),
);

interface NarratorSearchParams extends NarratorListSearchParams {
	create?: boolean;
}

interface NarratorsInfiniteData {
	pages: Array<{
		items: NarratorListItem[];
		[key: string]: unknown;
	}>;
	[key: string]: unknown;
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
	const { t } = useTranslation("narrators");
	const { t: tn } = useTranslation("narrator");
	const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
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

	const narratorIds = useMemo(() => narrators.map((s) => s.id), [narrators]);
	useNarratorsListWS(narratorIds, (narratorId, event) => {
		if (!narratorId) {
			qc.invalidateQueries({ queryKey: ["narrators"] });
			return;
		}
		qc.setQueryData<NarratorsInfiniteData>(["narrators", "paginated", queryOptions], (old) => {
			if (!old?.pages) return old;
			let changed = false;
			const pages = old.pages.map((page) => ({
				...page,
				items: page.items.map((item) => {
					if (item.id !== narratorId) return item;
					changed = true;
					return {
						...item,
						...(event.status !== undefined ? { status: event.status } : {}),
						...(event.substatus !== undefined ? { substatus: event.substatus } : {}),
						...(event.title !== undefined ? { title: event.title } : {}),
						...(event.permissionMode !== undefined ? { permissionMode: event.permissionMode } : {}),
						...(event.viewers !== undefined ? { viewers: event.viewers } : {}),
						updatedAt: new Date().toISOString(),
					};
				}),
			}));
			return changed ? { ...old, pages } : old;
		});
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
					<Button onClick={guardedOpen}>{t("newNarrator")}</Button>
				</Group>
			</Group>

			{/* Mobile header */}
			<Stack gap="xs" hiddenFrom="sm">
				<Group justify="space-between">
					<Title order={3}>{t("title")}</Title>
					<Group gap="xs">
						<NarratorListExtraFiltersButton state={listState} onChange={setSearch} />
						<Button size="xs" onClick={guardedOpen}>
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

			{opened && (
				<Suspense fallback={null}>
					<CreateNarratorModal opened={opened} onClose={close} onCreated={handleCreated} />
				</Suspense>
			)}

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
