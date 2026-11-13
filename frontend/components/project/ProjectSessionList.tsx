import { api } from "@frontend/lib/api";
import { Alert, Button, Card, Group, Loader, Stack, Text } from "@mantine/core";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/** Route-independent session browser shared by native and remote project pages. */
export function ProjectSessionList({
	projectId,
	enabled = true,
}: {
	projectId: string;
	enabled?: boolean;
}) {
	const { t } = useTranslation("projects");
	const sessions = useInfiniteQuery({
		queryKey: ["narrators", "project", projectId],
		queryFn: ({ pageParam }) =>
			api.listNarratorsPaginated({ projectId, limit: 30, cursor: pageParam }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled,
		gcTime: 60_000,
	});
	return (
		<Stack>
			{sessions.isLoading && <Loader size="sm" />}
			{sessions.isError && <Alert color="red">{t("compatibility.sessionsUnavailable")}</Alert>}
			{!sessions.isError &&
				sessions.data?.pages
					.flatMap((page) => page.items)
					.map((session) => (
						<Card key={session.id} withBorder>
							<Group justify="space-between">
								<Stack gap={2}>
									<Text>{session.title || session.id}</Text>
									<Text size="xs" c="dimmed">
										{session.cwd}
									</Text>
								</Stack>
								<Link
									to="/narrators/$narratorId"
									params={{ narratorId: session.id }}
									style={{ textDecoration: "none" }}
								>
									<Button component="span" variant="light">
										{t("compatibility.openSession")}
									</Button>
								</Link>
							</Group>
						</Card>
					))}
			{sessions.isSuccess && sessions.data.pages.every((page) => page.items.length === 0) && (
				<Text c="dimmed">{t("compatibility.noSessions")}</Text>
			)}
			{sessions.hasNextPage && (
				<Button
					variant="light"
					loading={sessions.isFetchingNextPage}
					onClick={() => void sessions.fetchNextPage()}
				>
					{t("compatibility.loadMore")}
				</Button>
			)}
		</Stack>
	);
}
