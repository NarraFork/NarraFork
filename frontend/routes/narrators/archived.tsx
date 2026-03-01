import {
	ActionIcon,
	Button,
	Card,
	Group,
	Loader,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { IconArchiveOff } from "@tabler/icons-react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorsPaginated, useUnarchiveNarrator } from "../../hooks/useNarrator";

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
	const { t } = useTranslation("narrators");
	const { i18n } = useTranslation();

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
												model: narrator.model,
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
		</Stack>
	);
}
