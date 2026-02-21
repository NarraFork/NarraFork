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

export const Route = createFileRoute("/sessions/archived")({
	component: ArchivedSessionsPage,
});

function ArchivedSessionsPage() {
	const {
		data: paginatedData,
		isLoading,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
	} = useNarratorsPaginated({ standalone: true, status: "archived" });
	const sessions = useMemo(
		() => paginatedData?.pages.flatMap((p) => p.items) ?? [],
		[paginatedData],
	);
	const unarchiveSession = useUnarchiveNarrator();
	const { t } = useTranslation("sessions");
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
				<Title order={2}>{t("archivedSessions")}</Title>
				<Button variant="subtle" component={Link} to="/sessions">
					{t("backToSessions")}
				</Button>
			</Group>

			{isLoading ? (
				<Loader />
			) : !sessions.length ? (
				<Text c="dimmed">{t("noArchivedSessions")}</Text>
			) : (
				<Stack>
					{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
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
										<Tooltip label={t("unarchive")}>
											<ActionIcon
												size="sm"
												color="teal"
												variant="subtle"
												loading={unarchiveSession.isPending}
												onClick={(e) => {
													e.preventDefault();
													e.stopPropagation();
													unarchiveSession.mutate(session.id);
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
