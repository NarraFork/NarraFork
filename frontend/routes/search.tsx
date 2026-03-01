import { Alert, Badge, Button, Card, Group, Loader, Mark, Stack, Text, Title } from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearch } from "../hooks/useSearch";

function highlightText(text: string, query: string): ReactNode {
	if (!query) return text;
	const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const parts = text.split(new RegExp(`(${escaped})`, "gi"));
	if (parts.length === 1) return text;
	return parts.map((part, i) =>
		part.toLowerCase() === query.toLowerCase() ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: stable split output
			<Mark key={i} color="yellow">
				{part}
			</Mark>
		) : (
			part
		),
	);
}

const linkStyle = { textDecoration: "none", color: "inherit" } as const;

/** Resolve the navigation target for a search result */
function getResultLink(
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	result: any,
): { to: string; params: Record<string, string>; hash?: string } | null {
	if (result.type === "chapter") {
		return { to: "/chapters/$chapterId", params: { chapterId: result.id } };
	}
	if (result.type === "message") {
		const hash = `msg-${result.id}`;
		if (result.chapterId) {
			return { to: "/chapters/$chapterId", params: { chapterId: result.chapterId }, hash };
		}
		if (result.narratorId) {
			return { to: "/narrators/$narratorId", params: { narratorId: result.narratorId }, hash };
		}
	}
	if (result.type === "narrator") {
		if (result.chapterId) {
			return { to: "/chapters/$chapterId", params: { chapterId: result.chapterId } };
		}
		return { to: "/narrators/$narratorId", params: { narratorId: result.id } };
	}
	return null;
}

interface SearchParams {
	q?: string;
}

export const Route = createFileRoute("/search")({
	component: SearchPage,
	validateSearch: (search: Record<string, unknown>): SearchParams => ({
		q: typeof search.q === "string" ? search.q : undefined,
	}),
});

function SearchPage() {
	const { q } = Route.useSearch();
	const [forceSearch, setForceSearch] = useState(false);
	const { data, isLoading, isShortQuery } = useSearch(
		q ?? "",
		"chapters,messages,narrators",
		forceSearch,
	);
	const { t } = useTranslation("search");

	// Reset force when query changes
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset on q change
	useEffect(() => {
		setForceSearch(false);
	}, [q]);

	return (
		<Stack>
			<Title order={2}>{t("title")}</Title>
			{q && (
				<Text c="dimmed" size="sm">
					{t("resultsFor", { query: q })}
				</Text>
			)}

			{isShortQuery && !forceSearch ? (
				<Alert color="yellow" radius="md">
					<Group>
						<Text size="sm">{t("shortQueryHint")}</Text>
						<Button size="xs" variant="light" onClick={() => setForceSearch(true)}>
							{t("searchAnyway")}
						</Button>
					</Group>
				</Alert>
			) : isLoading ? (
				<Loader />
			) : !data?.results?.length ? (
				<Text c="dimmed">{q ? t("noResults") : t("enterQuery")}</Text>
			) : (
				<Stack>
					{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
					{data.results.map((result: any) => {
						const key = `${result.type}-${result.id}`;
						const link = getResultLink(result);
						const card = (
							<Card
								key={key}
								shadow="sm"
								padding="md"
								withBorder
								style={{ textDecoration: "none", cursor: link ? "pointer" : undefined }}
							>
								<Group gap="xs" mb={4}>
									<Badge
										size="xs"
										color={
											result.type === "chapter"
												? "blue"
												: result.type === "narrator"
													? "indigo"
													: "grape"
										}
									>
										{result.type}
									</Badge>
									{result.title && <Text fw={500}>{highlightText(result.title, q ?? "")}</Text>}
								</Group>
								<Text size="sm" c="dimmed">
									{highlightText(result.snippet, q ?? "")}
								</Text>
							</Card>
						);
						if (!link) return card;
						return (
							<Link key={key} to={link.to} params={link.params} hash={link.hash} style={linkStyle}>
								{card}
							</Link>
						);
					})}
				</Stack>
			)}
		</Stack>
	);
}
