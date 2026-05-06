import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	Loader,
	SegmentedControl,
	Select,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearch } from "../hooks/useSearch";
import { formatSmartTime } from "../lib/format";
import {
	getSearchResultDisplayTitle,
	highlightSearchText,
	normalizeSearchType,
} from "../lib/search-utils";

const linkStyle = { textDecoration: "none", color: "inherit" } as const;

function humanizeEnumValue(value: string): string {
	const normalized = value.replace(/[_-]+/g, " ").trim();
	if (!normalized) return value;
	return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

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
		// Prefer direct narrator link — the /chapters/ route is a redirect that loses the hash
		if (result.narratorId) {
			return { to: "/narrators/$narratorId", params: { narratorId: result.narratorId }, hash };
		}
		if (result.chapterId) {
			return { to: "/chapters/$chapterId", params: { chapterId: result.chapterId }, hash };
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
	type?: string;
	sort?: string;
}

export const Route = createFileRoute("/search")({
	component: SearchPage,
	validateSearch: (search: Record<string, unknown>): SearchParams => ({
		q: typeof search.q === "string" ? search.q : undefined,
		type: normalizeSearchType(search.type),
		sort: typeof search.sort === "string" ? search.sort : undefined,
	}),
});

function SearchPage() {
	const { q, type = "all", sort = "relevance" } = Route.useSearch();
	const navigate = Route.useNavigate();
	const [forceSearch, setForceSearch] = useState(false);
	const { data, isLoading, isShortQuery } = useSearch(
		q ?? "",
		"chapters,messages,narrators",
		forceSearch,
	);
	const { t } = useTranslation("search");
	const translateSearchEnum = (prefix: string, value: string) =>
		t(`${prefix}_${value}`, { defaultValue: humanizeEnumValue(value) });
	const results = useMemo(() => {
		// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
		const items = ((data?.results ?? []) as any[]).filter((result) =>
			type === "all" ? true : result.type === type,
		);
		return [...items].sort((a, b) => {
			if (sort === "time") {
				const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? b.lastMessageAt ?? "") || 0;
				const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? a.lastMessageAt ?? "") || 0;
				return bTime - aTime;
			}
			if (sort === "type") return String(a.type).localeCompare(String(b.type));
			if (sort === "title") {
				const titleA = getSearchResultDisplayTitle(a, (id) => t("resultUntitled", { id }));
				const titleB = getSearchResultDisplayTitle(b, (id) => t("resultUntitled", { id }));
				return titleA.localeCompare(titleB);
			}
			return (b.matchScore ?? 0) - (a.matchScore ?? 0);
		});
	}, [data?.results, type, sort, t]);
	const counts = useMemo(() => {
		const all = data?.results ?? [];
		return {
			all: all.length,
			chapter: all.filter((r) => r.type === "chapter").length,
			narrator: all.filter((r) => r.type === "narrator").length,
			message: all.filter((r) => r.type === "message").length,
		};
	}, [data?.results]);

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

			{data?.results?.length ? (
				<Group justify="space-between" align="center">
					<SegmentedControl
						size="xs"
						value={type}
						onChange={(value) =>
							navigate({
								search: (prev) => ({ ...prev, type: value === "all" ? undefined : value }),
								replace: true,
							})
						}
						data={[
							{ value: "all", label: t("typeAll", { count: counts.all }) },
							{ value: "chapter", label: t("typeChapter", { count: counts.chapter }) },
							{ value: "narrator", label: t("typeNarrator", { count: counts.narrator }) },
							{ value: "message", label: t("typeMessage", { count: counts.message }) },
						]}
					/>
					<Select
						size="xs"
						w={150}
						value={sort}
						allowDeselect={false}
						onChange={(value) =>
							value &&
							navigate({
								search: (prev) => ({ ...prev, sort: value === "relevance" ? undefined : value }),
								replace: true,
							})
						}
						data={[
							{ value: "relevance", label: t("sortRelevance") },
							{ value: "time", label: t("sortTime") },
							{ value: "type", label: t("sortType") },
							{ value: "title", label: t("sortTitle") },
						]}
					/>
				</Group>
			) : null}

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
			) : !results.length ? (
				<Text c="dimmed">{t("noFilteredResults")}</Text>
			) : (
				<Stack>
					{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
					{results.map((result: any) => {
						const key = `${result.type}-${result.id}`;
						const link = getResultLink(result);
						const title = getSearchResultDisplayTitle(result, (id) => t("resultUntitled", { id }));
						const timestamp = result.updatedAt ?? result.createdAt ?? result.lastMessageAt;
						const card = (
							<Card
								key={key}
								shadow="sm"
								padding="md"
								withBorder
								style={{ textDecoration: "none", cursor: link ? "pointer" : undefined }}
							>
								<Group gap="xs" mb={6} justify="space-between" wrap="nowrap">
									<Group gap="xs" style={{ minWidth: 0 }}>
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
											{t(`label_${result.type}`)}
										</Badge>
										<Text fw={500} truncate>
											{highlightSearchText(title, q ?? "")}
										</Text>
									</Group>
									<Badge size="xs" variant="light" color="gray">
										{t("score", { score: result.matchScore ?? 0 })}
									</Badge>
								</Group>
								<Text size="sm" c="dimmed" lineClamp={3} mb={8}>
									{highlightSearchText(result.snippet ?? "", q ?? "")}
								</Text>
								<Group gap={6} wrap="wrap">
									{result.projectName && <Badge variant="outline">{result.projectName}</Badge>}
									{result.chapterTitle && <Badge variant="light">{result.chapterTitle}</Badge>}
									{result.narratorTitle && <Badge variant="light">{result.narratorTitle}</Badge>}
									{result.status && (
										<Badge variant="dot">
											{translateSearchEnum(`status_${result.type}`, result.status)}
										</Badge>
									)}
									{result.messageRole && (
										<Badge variant="dot">
											{translateSearchEnum("messageRole", result.messageRole)}
										</Badge>
									)}
									{result.matchField && (
										<Badge variant="outline">
											{t("matchField", {
												field: translateSearchEnum("matchField", result.matchField),
											})}
										</Badge>
									)}
									{timestamp && (
										<Text size="xs" c="dimmed">
											{formatSmartTime(timestamp)}
										</Text>
									)}
								</Group>
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
