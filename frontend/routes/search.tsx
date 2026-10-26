import {
	Alert,
	Button,
	Group,
	Loader,
	Pagination,
	SegmentedControl,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EntityResultCard } from "../components/search/EntityResultCard";
import { SearchFilterBar, type SearchFilterState } from "../components/search/SearchFilterBar";
import { SessionResultCard } from "../components/search/SessionResultCard";
import {
	SEARCH_PAGE_LIMIT,
	SEARCH_SECTION_ORDER,
	useSearchOverview,
	useSearchSection,
} from "../hooks/useSearch";
import type {
	EntitySearchResult,
	SearchRequest,
	SearchSectionName,
	SearchSectionPage,
	SessionSearchResult,
} from "../lib/api";
import {
	DEFAULT_SEARCH_SORT,
	formatSearchTotal,
	normalizeSearchInclude,
	normalizeSearchPage,
	normalizeSearchRange,
	normalizeSearchSort,
	normalizeSearchTab,
	type SearchTab,
	type SearchTimeRange,
	searchPageCount,
	searchRangeStart,
} from "../lib/search-utils";

interface SearchParams {
	q?: string;
	/** The open tab; absent means the overview of every section. */
	tab?: string;
	sort?: string;
	/** Comma-separated content added to the default scope. */
	include?: string;
	project?: string;
	range?: string;
	mine?: string;
	/** `all` lifts the recent-days limit on a query of only short terms. */
	history?: string;
	/** 1-based page of the open tab. */
	page?: number;
}

const optionalId = (value: unknown) =>
	typeof value === "string" && value.length > 0 && value.length <= 64 ? value : undefined;

export const Route = createFileRoute("/search")({
	component: SearchPage,
	validateSearch: (search: Record<string, unknown>): SearchParams => {
		// `type` is the pre-sections name of `tab`; old links keep opening the right tab.
		const tab = normalizeSearchTab(search.tab ?? search.type);
		const sort = normalizeSearchSort(search.sort);
		return {
			q: typeof search.q === "string" ? search.q : undefined,
			tab: tab === "all" ? undefined : tab,
			sort: sort === DEFAULT_SEARCH_SORT ? undefined : sort,
			include: normalizeSearchInclude(search.include).join(",") || undefined,
			project: optionalId(search.project),
			range: normalizeSearchRange(search.range),
			mine: search.mine === "1" || search.mine === 1 || search.mine === true ? "1" : undefined,
			history: search.history === "all" ? "all" : undefined,
			page: tab === "all" ? undefined : normalizeSearchPage(search.page),
		};
	},
});

/** Every section's cards render through this one switch. */
function ResultCard({
	result,
	request,
}: {
	result: SessionSearchResult | EntitySearchResult;
	request: SearchRequest;
}) {
	return result.type === "session" ? (
		<SessionResultCard result={result} request={request} />
	) : (
		<EntityResultCard result={result} query={request.q} />
	);
}

/** The overview: each section's best few, with a way into the full section. */
function Overview({
	sections,
	request,
	onOpen,
}: {
	sections: Partial<
		Record<SearchSectionName, SearchSectionPage<SessionSearchResult | EntitySearchResult>>
	>;
	request: SearchRequest;
	onOpen: (tab: SearchSectionName) => void;
}) {
	const { t } = useTranslation("search");
	const visible = SEARCH_SECTION_ORDER.filter((name) => (sections[name]?.items.length ?? 0) > 0);
	if (visible.length === 0) return <Text c="dimmed">{t("noResults")}</Text>;
	return (
		<Stack gap="lg">
			{visible.map((name) => {
				const page = sections[name] as SearchSectionPage<SessionSearchResult | EntitySearchResult>;
				return (
					<Stack key={name} gap="xs">
						<Group justify="space-between" align="center">
							<Title order={4}>
								{t(`section_${name}`)}{" "}
								<Text span c="dimmed" fw={400}>
									{formatSearchTotal(page)}
								</Text>
							</Title>
							{page.nextCursor && (
								<Button size="compact-sm" variant="subtle" onClick={() => onOpen(name)}>
									{t("viewAll", { count: formatSearchTotal(page) })}
								</Button>
							)}
						</Group>
						{page.items.map((result) => (
							<ResultCard key={`${result.type}-${result.id}`} result={result} request={request} />
						))}
					</Stack>
				);
			})}
		</Stack>
	);
}

/** One section, a page at a time, with page numbers below. */
function SectionList({
	section,
	request,
	page,
	onPage,
}: {
	section: SearchSectionName;
	request: SearchRequest;
	page: number;
	onPage: (page: number) => void;
}) {
	const { t } = useTranslation("search");
	const top = useRef<HTMLDivElement>(null);
	const query = useSearchSection(request, section, page, true);
	const data = query.data;
	const items = (data?.items ?? []) as Array<SessionSearchResult | EntitySearchResult>;
	if (query.isLoading) return <Loader />;
	if (items.length === 0 && page === 1) return <Text c="dimmed">{t("noResults")}</Text>;
	const pages = Math.max(page, searchPageCount(data, SEARCH_PAGE_LIMIT));
	return (
		<Stack ref={top} style={{ opacity: query.isPlaceholderData ? 0.6 : 1 }}>
			{items.map((result) => (
				<ResultCard key={`${result.type}-${result.id}`} result={result} request={request} />
			))}
			{pages > 1 && (
				<Stack gap={4} align="center" mt="sm">
					<Pagination
						total={pages}
						value={page}
						onChange={(next) => {
							onPage(next);
							// The page scrolls inside the app shell, not the window.
							top.current?.scrollIntoView({ block: "start" });
						}}
						size="sm"
						siblings={1}
						boundaries={1}
					/>
					{data?.totalIsLowerBound && (
						<Text size="xs" c="dimmed">
							{t("pagesLowerBound", { count: data.total })}
						</Text>
					)}
				</Stack>
			)}
		</Stack>
	);
}

function SearchPage() {
	const params = Route.useSearch();
	const navigate = Route.useNavigate();
	const { t } = useTranslation("search");
	const tab: SearchTab = normalizeSearchTab(params.tab);
	const filters: SearchFilterState = useMemo(
		() => ({
			sort: normalizeSearchSort(params.sort),
			include: normalizeSearchInclude(params.include),
			projectId: params.project,
			range: normalizeSearchRange(params.range) as SearchTimeRange | undefined,
			mine: params.mine === "1",
		}),
		[params],
	);
	const request: SearchRequest = useMemo(
		() => ({
			q: (params.q ?? "").trim(),
			sort: filters.sort,
			include: filters.include,
			projectId: filters.projectId,
			from: filters.range ? searchRangeStart(filters.range) : undefined,
			mine: filters.mine,
			fullHistory: params.history === "all",
		}),
		[params.q, params.history, filters],
	);
	const overview = useSearchOverview(request);
	const sections = overview.data?.sections ?? {};

	const setFilters = (patch: Partial<SearchFilterState>) => {
		const next = { ...filters, ...patch };
		navigate({
			search: (prev) => ({
				...prev,
				sort: next.sort === DEFAULT_SEARCH_SORT ? undefined : next.sort,
				include: next.include.join(",") || undefined,
				project: next.projectId,
				range: next.range,
				mine: next.mine ? "1" : undefined,
			}),
			replace: true,
		});
	};
	const openTab = (value: SearchTab) =>
		navigate({
			search: (prev) => ({ ...prev, tab: value === "all" ? undefined : value, page: undefined }),
			replace: true,
		});
	const openPage = (page: number) =>
		navigate({ search: (prev) => ({ ...prev, page: page > 1 ? page : undefined }) });

	const recentDays = sections.sessions?.recentDays;
	const searchFullHistory = () =>
		navigate({ search: (prev) => ({ ...prev, history: "all", page: undefined }), replace: true });

	const tabLabel = (name: SearchSectionName) =>
		t(`tab_${name}`, { count: formatSearchTotal(sections[name]) });

	return (
		<Stack>
			<Title order={2}>{t("title")}</Title>
			{request.q ? (
				<Text c="dimmed" size="sm">
					{t("resultsFor", { query: request.q })}
				</Text>
			) : (
				<Text c="dimmed">{t("enterQuery")}</Text>
			)}

			{request.q && (
				<>
					<SearchFilterBar state={filters} onChange={setFilters} />
					<SegmentedControl
						size="xs"
						value={tab}
						onChange={(value) => openTab(normalizeSearchTab(value))}
						data={[
							{ value: "all", label: t("tab_all") },
							...SEARCH_SECTION_ORDER.map((name) => ({ value: name, label: tabLabel(name) })),
						]}
						style={{ alignSelf: "flex-start" }}
					/>
					{recentDays && (
						<Alert color="blue" variant="light" p="xs">
							<Group gap="xs" justify="space-between" wrap="wrap">
								<Text size="sm">{t("recentOnly", { days: recentDays })}</Text>
								<Button size="compact-sm" variant="light" onClick={searchFullHistory}>
									{t("searchFullHistory")}
								</Button>
							</Group>
						</Alert>
					)}
					{tab === "all" ? (
						overview.isLoading ? (
							<Loader />
						) : (
							<Overview sections={sections} request={request} onOpen={openTab} />
						)
					) : (
						<SectionList
							key={tab}
							section={tab}
							request={request}
							page={params.page ?? 1}
							onPage={openPage}
						/>
					)}
				</>
			)}
		</Stack>
	);
}
