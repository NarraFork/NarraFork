import {
	ActionIcon,
	Button,
	Card,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconArchiveOff, IconTrash } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../hooks/useModels";
import {
	useDeleteNarrator,
	useNarratorsPaginated,
	useUnarchiveNarrator,
} from "../../hooks/useNarrator";
import { FOLLOW_DEFAULT_MODEL } from "../../lib/constants";

export const Route = createFileRoute("/narrators/archived")({
	component: ArchivedNarratorsPage,
});

function ArchivedNarratorsPage() {
	const {
		data: paginatedData,
		isLoading,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useNarratorsPaginated({ standalone: true, status: "archived" });
	const narrators = useMemo(
		() => paginatedData?.pages.flatMap((p) => p.items) ?? [],
		[paginatedData],
	);
	const unarchiveNarrator = useUnarchiveNarrator();
	const deleteNarrator = useDeleteNarrator();
	const { t } = useTranslation("narrators");
	const { t: tc } = useTranslation("common");
	const { i18n } = useTranslation();
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
		if (!sentinelRef.current || !hasNextPage) return;
		const observer = new IntersectionObserver(([entry]) => {
			if (entry.isIntersecting && !isFetchingNextPage) fetchNextPage();
		});
		observer.observe(sentinelRef.current);
		return () => observer.disconnect();
	}, [hasNextPage, isFetchingNextPage, fetchNextPage]);

	return (
		<Stack>
			<Group justify="space-between">
				<Title order={2}>{t("archivedNarrators")}</Title>
				<Button variant="subtle" component={Link} to="/narrators">
					{t("backToNarrators")}
				</Button>
			</Group>

			{isLoading ? (
				<Loader />
			) : !narrators.length ? (
				<Text c="dimmed">{t("noArchivedNarrators")}</Text>
			) : (
				<Stack>
					{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
					{narrators.map((narrator: any) => (
						<Link
							key={narrator.id}
							to="/narrators/$narratorId"
							params={{ narratorId: narrator.id }}
							style={{ textDecoration: "none", color: "inherit" }}
						>
							<Card shadow="sm" padding="md" withBorder>
								<Group justify="space-between">
									<div>
										<Text fw={500}>
											{narrator.title || t("narratorId", { id: narrator.id.slice(0, 8) })}
										</Text>
										<Text size="sm" c="dimmed">
											{t("narratorMeta", {
												model:
													narrator.model === FOLLOW_DEFAULT_MODEL
														? t("followDefault", { model: defaultModelValue })
														: narrator.model,
												count: narrator.messageCount ?? 0,
											})}
										</Text>
										{narrator.cwd && (
											<Text size="xs" c="dimmed" truncate>
												{t("cwdLabel", { path: narrator.cwd })}
											</Text>
										)}
									</div>
									<Group>
										<Text size="xs" c="dimmed">
											{new Date(narrator.createdAt).toLocaleDateString(i18n.language)}
										</Text>
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
					))}
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
