import { Badge, Card, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useSearch } from "../hooks/useSearch";

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
	const { data, isLoading } = useSearch(q ?? "");

	return (
		<Stack>
			<Title order={2}>Search Results</Title>
			{q && (
				<Text c="dimmed" size="sm">
					Results for &quot;{q}&quot;
				</Text>
			)}

			{isLoading ? (
				<Loader />
			) : !data?.results?.length ? (
				<Text c="dimmed">{q ? "No results found." : "Enter a search query in the header."}</Text>
			) : (
				<Stack>
					{data.results.map((result: any) => {
						const card = (
							<Card
								key={`${result.type}-${result.id}`}
								shadow="sm"
								padding="md"
								withBorder
								style={{ textDecoration: "none" }}
							>
								<Group gap="xs" mb={4}>
									<Badge size="xs" color={result.type === "chapter" ? "blue" : "grape"}>
										{result.type}
									</Badge>
									{result.title && <Text fw={500}>{result.title}</Text>}
								</Group>
								<Text size="sm" c="dimmed">
									{result.snippet}
								</Text>
							</Card>
						);
						if (result.type === "chapter") {
							return (
								<Link
									key={`${result.type}-${result.id}`}
									to="/chapters/$chapterId"
									params={{ chapterId: result.id }}
									style={{ textDecoration: "none", color: "inherit" }}
								>
									{card}
								</Link>
							);
						}
						return card;
					})}
				</Stack>
			)}
		</Stack>
	);
}
