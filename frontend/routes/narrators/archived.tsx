import { Button, Group, Loader, Modal, Stack, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	NarratorListCard,
	type NarratorListItem,
} from "../../components/narrator/NarratorListCard";
import {
	NarratorListControls,
	NarratorListExtraFiltersButton,
	NarratorListLoadMoreButton,
	NarratorListLocalSearchSummary,
} from "../../components/narrator/NarratorListControls";
import {
	buildNarratorListQueryOptions,
	filterNarratorsByLocalQuery,
	getNarratorListState,
	type NarratorListSearchParams,
	normalizeNarratorListSearchPatch,
	useNarratorInfiniteScroll,
	validateNarratorListSearch,
} from "../../components/narrator/narrator-list-utils";
import { useAllModels } from "../../hooks/useModels";
import {
	useDeleteNarrator,
	useNarratorsPaginated,
	useUnarchiveNarrator,
} from "../../hooks/useNarrator";
import { useNarratorDeleteCapability } from "../../hooks/usePlatform";

export const Route = createFileRoute("/narrators/archived")({
	component: ArchivedNarratorsPage,
	validateSearch: validateNarratorListSearch,
});

function ArchivedNarratorsPage() {
	const search = Route.useSearch();
	const navigate = useNavigate();
	const listState = useMemo(() => getNarratorListState(search), [search]);
	const { localQuery } = listState;

	const setSearch = useCallback(
		(patch: Partial<NarratorListSearchParams>) => {
			navigate({
				to: "/narrators/archived",
				search: (prev: NarratorListSearchParams) => normalizeNarratorListSearchPatch(prev, patch),
				replace: true,
			});
		},
		[navigate],
	);

	const queryOptions = useMemo(
		() => buildNarratorListQueryOptions(listState, "archived"),
		[listState],
	);
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
	const unarchiveNarrator = useUnarchiveNarrator();
	const deleteNarrator = useDeleteNarrator();
	const { t } = useTranslation("narrators");
	const { t: tc } = useTranslation("common");
	const { defaultModelValue } = useAllModels();
	const narratorDeleteCapability = useNarratorDeleteCapability();
	const deleteSupported = narratorDeleteCapability.supported;
	const deleteUnsupportedReason = narratorDeleteCapability.reason ?? t("deleteNarratorUnsupported");

	const [deleteOpened, { open: openDelete, close: closeDelete }] = useDisclosure(false);
	const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);

	const handleDelete = useCallback(
		(narrator: NarratorListItem) => {
			if (!deleteSupported) return;
			setDeleteTarget({
				id: narrator.id,
				title: narrator.title || narrator.id.slice(0, 8),
			});
			openDelete();
		},
		[deleteSupported, openDelete],
	);

	const confirmDelete = useCallback(() => {
		if (!deleteSupported || !deleteTarget) return;
		deleteNarrator.mutate(deleteTarget.id, { onSuccess: closeDelete });
	}, [deleteSupported, deleteTarget, deleteNarrator, closeDelete]);

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

	return (
		<Stack>
			{/* Desktop header */}
			<Group justify="space-between" visibleFrom="sm">
				<Title order={2}>{t("archivedNarrators")}</Title>
				<Group gap="xs">
					<NarratorListControls state={listState} onChange={setSearch} includeExtraFilters />
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
						<NarratorListExtraFiltersButton state={listState} onChange={setSearch} />
						<Button variant="subtle" size="xs" component={Link} to="/narrators">
							{t("backToNarrators")}
						</Button>
					</Group>
				</Group>
				<NarratorListControls state={listState} onChange={setSearch} layout="mobile" />
			</Stack>

			<NarratorListLocalSearchSummary
				localQuery={localQuery}
				shown={filteredNarrators.length}
				loaded={narrators.length}
			/>

			{isLoading ? (
				<Loader />
			) : !narrators.length ? (
				<Text c="dimmed">{t("noArchivedNarrators")}</Text>
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
							variant="archived"
							narrator={narrator}
							localQuery={localQuery}
							defaultModelValue={defaultModelValue}
							unarchiveLoading={unarchiveNarrator.isPending}
							deleteSupported={deleteSupported}
							deleteUnsupportedReason={deleteUnsupportedReason}
							onUnarchive={(narratorId) => unarchiveNarrator.mutate(narratorId)}
							onDelete={handleDelete}
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
						<Button
							color="red"
							onClick={confirmDelete}
							loading={deleteNarrator.isPending}
							disabled={!deleteSupported}
							title={!deleteSupported ? deleteUnsupportedReason : undefined}
						>
							{t("deleteNarrator")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Stack>
	);
}
