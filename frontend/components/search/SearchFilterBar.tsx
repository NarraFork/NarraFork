import { Button, Checkbox, Menu, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { IconCheck, IconChevronDown, IconSearch } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjects } from "../../hooks/useProjects";
import {
	DEFAULT_SEARCH_SORT,
	normalizeSearchInclude,
	SEARCH_INCLUDES,
	SEARCH_TIME_RANGES,
	type SearchInclude,
	type SearchSortMode,
	type SearchTimeRange,
} from "../../lib/search-utils";

export interface SearchFilterState {
	sort: SearchSortMode;
	include: SearchInclude[];
	projectId?: string;
	range?: SearchTimeRange;
	mine: boolean;
}

interface NamedEntity {
	id: string;
	name?: string;
	title?: string;
}

/** Long project lists get a filter box at the top of the menu. */
const PROJECT_FILTER_MIN = 8;

/**
 * A filter as a compact text button: grey with its name while it is at its default,
 * highlighted with the chosen value once set. The menu holds the choices.
 */
function FilterMenu({
	label,
	active,
	width = 200,
	keepOpen,
	children,
}: {
	label: string;
	active: boolean;
	width?: number;
	/** Checkbox menus stay open so several can be toggled in one go. */
	keepOpen?: boolean;
	children: ReactNode;
}) {
	return (
		<Menu position="bottom-end" width={width} shadow="md" closeOnItemClick={!keepOpen}>
			<Menu.Target>
				<Button
					size="compact-sm"
					variant={active ? "light" : "subtle"}
					color={active ? undefined : "gray"}
					rightSection={<IconChevronDown size={12} />}
					styles={{ section: { marginInlineStart: 4 } }}
					fw={active ? 500 : 400}
				>
					{label}
				</Button>
			</Menu.Target>
			<Menu.Dropdown>{children}</Menu.Dropdown>
		</Menu>
	);
}

/** One choice of a single-choice menu: a check in front of the current one. */
function ChoiceItem({
	selected,
	onClick,
	children,
}: {
	selected: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<Menu.Item
			onClick={onClick}
			leftSection={<IconCheck size={14} style={{ visibility: selected ? "visible" : "hidden" }} />}
		>
			{children}
		</Menu.Item>
	);
}

/**
 * Scope and filters for global search, as one row of compact menus: project, time, sort,
 * and "More" (only my sessions, extra content to include). Every change goes to the URL,
 * so a filtered search survives reloads and shared links.
 */
export function SearchFilterBar({
	state,
	onChange,
}: {
	state: SearchFilterState;
	onChange: (patch: Partial<SearchFilterState>) => void;
}) {
	const { t } = useTranslation("search");
	const projects = useProjects();
	const [projectFilter, setProjectFilter] = useState("");
	const projectList = ((projects.data ?? []) as NamedEntity[]).map((project) => ({
		id: project.id,
		name: project.name || project.title || project.id,
	}));
	const currentProject = projectList.find((project) => project.id === state.projectId);
	const shownProjects = projectFilter.trim()
		? projectList.filter((project) =>
				project.name.toLowerCase().includes(projectFilter.trim().toLowerCase()),
			)
		: projectList;
	const moreCount = state.include.length + (state.mine ? 1 : 0);

	const toggleInclude = (name: SearchInclude, on: boolean) =>
		onChange({
			include: normalizeSearchInclude(
				on ? [...state.include, name] : state.include.filter((value) => value !== name),
			),
		});

	return (
		<>
			<FilterMenu
				label={state.projectId ? (currentProject?.name ?? t("filterProject")) : t("filterProject")}
				active={!!state.projectId}
				width={240}
			>
				{projectList.length >= PROJECT_FILTER_MIN && (
					<TextInput
						size="xs"
						m={4}
						mb={6}
						placeholder={t("filterProjectSearch")}
						leftSection={<IconSearch size={12} />}
						value={projectFilter}
						onChange={(e) => setProjectFilter(e.currentTarget.value)}
						// Menu's own keyboard navigation would swallow typing otherwise.
						onKeyDown={(e) => e.stopPropagation()}
						aria-label={t("filterProjectSearch")}
					/>
				)}
				<ChoiceItem selected={!state.projectId} onClick={() => onChange({ projectId: undefined })}>
					{t("allProjects")}
				</ChoiceItem>
				<ScrollArea.Autosize mah={280} type="auto">
					{shownProjects.map((project) => (
						<ChoiceItem
							key={project.id}
							selected={project.id === state.projectId}
							onClick={() => onChange({ projectId: project.id })}
						>
							<Text size="sm" truncate>
								{project.name}
							</Text>
						</ChoiceItem>
					))}
				</ScrollArea.Autosize>
			</FilterMenu>

			<FilterMenu
				label={state.range ? t(`range_${state.range}`) : t("filterTime")}
				active={!!state.range}
				width={160}
			>
				<ChoiceItem selected={!state.range} onClick={() => onChange({ range: undefined })}>
					{t("range_all")}
				</ChoiceItem>
				{(Object.keys(SEARCH_TIME_RANGES) as SearchTimeRange[]).map((range) => (
					<ChoiceItem
						key={range}
						selected={state.range === range}
						onClick={() => onChange({ range })}
					>
						{t(`range_${range}`)}
					</ChoiceItem>
				))}
			</FilterMenu>

			<FilterMenu
				label={state.sort === "time" ? t("sortTime") : t("sortRelevance")}
				active={state.sort !== DEFAULT_SEARCH_SORT}
				width={140}
			>
				<ChoiceItem
					selected={state.sort === "relevance"}
					onClick={() => onChange({ sort: "relevance" })}
				>
					{t("sortRelevance")}
				</ChoiceItem>
				<ChoiceItem selected={state.sort === "time"} onClick={() => onChange({ sort: "time" })}>
					{t("sortTime")}
				</ChoiceItem>
			</FilterMenu>

			<FilterMenu
				label={moreCount > 0 ? t("filterMoreCount", { count: moreCount }) : t("filterMore")}
				active={moreCount > 0}
				width={220}
				keepOpen
			>
				<Stack gap={10} p={8}>
					<Checkbox
						size="xs"
						label={t("mineOnly")}
						checked={state.mine}
						onChange={(e) => onChange({ mine: e.currentTarget.checked })}
					/>
					<Text size="xs" c="dimmed" fw={500} mt={2}>
						{t("includeLabel")}
					</Text>
					{SEARCH_INCLUDES.map((name) => (
						<Checkbox
							key={name}
							size="xs"
							label={t(`include_${name}`)}
							checked={state.include.includes(name)}
							onChange={(e) => toggleInclude(name, e.currentTarget.checked)}
						/>
					))}
				</Stack>
			</FilterMenu>
		</>
	);
}
